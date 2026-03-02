const express = require('express');
const path = require('path');
const multer = require('multer');
const { JSDOM, VirtualConsole } = require('jsdom');
const axeCore = require('axe-core');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

// Weight map for our custom algorithm
const impactWeights = {
    critical: 10,
    serious: 6,
    moderate: 3,
    minor: 1,
    unknown: 1
};

async function performAudit(content, isUrl = false) {
    return new Promise(async (resolve, reject) => {
        try {
            // Keep the virtual console to keep the terminal clean
            const virtualConsole = new VirtualConsole();
            virtualConsole.sendTo(console, { omitJSDOMErrors: true });
            virtualConsole.on("jsdomError", (err) => {
                if (err.message.includes("not implemented") && err.message.includes("HTMLCanvasElement")) return; 
                console.error(err);
            });

            const jsdomOptions = { runScripts: "dangerously", resources: "usable", virtualConsole: virtualConsole };
            let dom = isUrl ? await JSDOM.fromURL(content, jsdomOptions) : new JSDOM(content, jsdomOptions);

            const axeSource = axeCore.source;
            dom.window.eval(axeSource);

            const isSnippet = !isUrl && !content.toLowerCase().includes('<html');
            
            // 1. BASE RULES: Disable color-contrast globally because don't have 'canvas' installed
            const baseRules = {
                'color-contrast': { enabled: false }
            };

            // 2. SNIPPET RULES: Disable document-level rules if it's just a small snippet
            const snippetRules = isSnippet ? {
                'document-title': { enabled: false }, 
                'html-has-lang': { enabled: false },
                'page-has-heading-one': { enabled: false }, 
                'landmark-one-main': { enabled: false },
                'region': { enabled: false }, 
                'bypass': { enabled: false }
            } : {};

            // 3. Combine the rules
            const auditOptions = {
                rules: {
                    ...baseRules,
                    ...snippetRules
                }
            };

            // Run the audit with the options
            dom.window.axe.run(dom.window.document, auditOptions, (err, results) => {
                if (err) return reject(err);

                const totalElements = Math.max(dom.window.document.querySelectorAll('*').length, 1);
                let totalPenaltyPoints = 0;

                let mappedViolations = results.violations.map(violation => {
                    const impact = violation.impact || 'unknown';
                    totalPenaltyPoints += (impactWeights[impact] * violation.nodes.length);

                    let v = {
                        id: violation.id,
                        impact: impact, 
                        description: violation.description,
                        help: violation.help,
                        helpUrl: violation.helpUrl,
                        tags: violation.tags.filter(tag => tag.startsWith('wcag')),
                        nodes: violation.nodes.map(node => ({ html: node.html, failureSummary: node.failureSummary }))
                    };

                    if (v.id === 'image-alt') v.description += ' Unless this is a decorative image, it needs descriptive text. If the image itself has text, include it in quotes.';
                    return v;
                });

                const emptyAltImages = dom.window.document.querySelectorAll('img[alt=""]');
                if (emptyAltImages.length > 0) {
                    totalPenaltyPoints += (impactWeights['moderate'] * emptyAltImages.length);
                    mappedViolations.push({
                        id: 'custom-empty-alt-review',
                        impact: 'moderate',
                        description: 'This image has an empty alt attribute (alt=""). Manual verification needed.',
                        help: 'Verify decorative image usage.',
                        helpUrl: 'https://www.w3.org/WAI/tutorials/images/decorative/',
                        tags: ['wcag2a', 'wcag111', 'manual-review'],
                        nodes: Array.from(emptyAltImages).map(img => ({ html: img.outerHTML, failureSummary: 'Manual review required.' }))
                    });
                }

                const rawScore = 100 - ((totalPenaltyPoints / totalElements) * 100);
                const finalScore = Math.max(0, Math.round(rawScore));

                resolve({
                    score: finalScore,
                    totalElements: totalElements,
                    violations: mappedViolations
                });
            });
        } catch (error) { reject(error); }
    });
}

app.get('/', (req, res) => res.render('index', { title: 'A11yAudit | Sandbox' }));
app.get('/dashboard', (req, res) => res.render('dashboard', { title: 'A11yAudit | Project Dashboard' }));

app.post('/run-audit', upload.array('auditFiles', 10), async (req, res) => {
    try {
        const urlInput = req.body.userInput || '';
        let fileReports = [];
        let totalProjectScore = 0;

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const htmlContent = fs.readFileSync(file.path, 'utf8');
                fs.unlinkSync(file.path);
                
                const report = await performAudit(htmlContent, false);
                fileReports.push({ sourceFile: file.originalname, ...report });
                totalProjectScore += report.score;
            }
        } else if (urlInput.startsWith('http')) {
            const report = await performAudit(urlInput, true);
            fileReports.push({ sourceFile: urlInput, ...report });
            totalProjectScore += report.score;
        } else if (urlInput.trim().length > 0) {
            // This captures the raw snippet text from the sandbox UI
            const report = await performAudit(urlInput, false);
            fileReports.push({ sourceFile: "Snippet", ...report });
            totalProjectScore += report.score;
        } else {
            return res.status(400).json({ error: "Please provide a valid live URL, snippet, or HTML files." });
        }

        const averageScore = fileReports.length > 0 ? Math.round(totalProjectScore / fileReports.length) : 0;

        res.json({ 
            status: "success", 
            aggregateScore: averageScore, 
            files: fileReports 
        });

    } catch (error) {
        console.error("Audit Engine Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`A11yAudit Engine active on port ${PORT}`));