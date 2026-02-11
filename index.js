const express = require('express');
const path = require('path');
const multer = require('multer');
const { JSDOM, VirtualConsole } = require('jsdom');
const axeCore = require('axe-core');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// 1. App Configuration
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

// 2. The Core Audit Function
async function performAudit(htmlContent) {
    return new Promise((resolve, reject) => {
        try {
            // --- ERROR SUPPRESSION START ---
            // This stops the "HTMLCanvasElement" error from spamming your terminal
            // if the canvas package isn't perfectly installed.
            const virtualConsole = new VirtualConsole();
            virtualConsole.sendTo(console, { omitJSDOMErrors: true });
            
            virtualConsole.on("jsdomError", (err) => {
                if (err.message.includes("not implemented") && err.message.includes("HTMLCanvasElement")) {
                    // Ignore the canvas error specifically
                    return; 
                }
                console.error(err);
            });
            // --- ERROR SUPPRESSION END ---

            // Create JSDOM with the virtual console
            const dom = new JSDOM(htmlContent, {
                runScripts: "dangerously",
                resources: "usable",
                virtualConsole: virtualConsole 
            });

            // Inject axe-core source
            const axeSource = axeCore.source;
            dom.window.eval(axeSource);

            // Run the audit
            dom.window.axe.run(dom.window.document, (err, results) => {
                if (err) return reject(err);

                const mappedViolations = results.violations.map(violation => ({
                    id: violation.id,
                    impact: violation.impact,
                    description: violation.description,
                    help: violation.help,
                    helpUrl: violation.helpUrl,
                    tags: violation.tags.filter(tag => tag.startsWith('wcag')),
                    nodes: violation.nodes.map(node => ({
                        html: node.html,
                        target: node.target,
                        failureSummary: node.failureSummary
                    }))
                }));

                resolve(mappedViolations);
            });

        } catch (error) {
            reject(error);
        }
    });
}

// 3. Routes
app.get('/', (req, res) => {
    res.render('index', { title: 'A11yAudit | Transparency Framework' });
});

app.post('/run-audit', upload.single('auditFile'), async (req, res) => {
    try {
        let htmlToScan = req.body.userInput || '';

        if (req.file) {
            htmlToScan = fs.readFileSync(req.file.path, 'utf8');
            fs.unlinkSync(req.file.path);
        }

        if (!htmlToScan || htmlToScan.trim().length === 0) {
            return res.status(400).json({ 
                score: 0, 
                count: 0, 
                issues: [], 
                error: "Empty content provided." 
            });
        }

        console.log("🔍 Starting Audit...");
        
        const violations = await performAudit(htmlToScan);
        
        console.log(`✅ Audit Complete. Found ${violations.length} violations.`);

        const score = Math.max(0, 100 - (violations.length * 5));

        res.json({
            status: "success",
            score: score,
            count: violations.length,
            issues: violations
        });

    } catch (error) {
        console.error("❌ Audit Engine Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 A11yAudit Engine active on port ${PORT}`));