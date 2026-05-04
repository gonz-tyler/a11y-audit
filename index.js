const express = require('express');
const path = require('path');
const multer = require('multer');
const { JSDOM, VirtualConsole } = require('jsdom');
const axeCore = require('axe-core');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

const impactWeights = { critical: 10, serious: 6, moderate: 3, minor: 1, unknown: 1 };

// Cache to prevent hammering Deque's servers for repeated rules
const dequeCache = new Map();

// --- DEQUE UNIVERSITY SCRAPER ---
async function fetchDisabilitiesFromDeque(url) {
    // Only attempt to scrape Deque URLs
    if (!url || !url.includes('dequeuniversity.com')) return ['Unknown'];
    
    // Return cached result if we've already scraped this rule
    if (dequeCache.has(url)) return dequeCache.get(url);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error('Bad status code');

        const html = await response.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        // Target the specific list items inside the disability div
        const liElements = document.querySelectorAll('.disabilityTypesAffectedData ul li');
        
        // Extract text, ignoring the icons/images, and clean up whitespace
        const disabilities = Array.from(liElements)
            .map(li => li.textContent.trim())
            .filter(text => text.length > 0);

        const result = disabilities.length > 0 ? disabilities : ['Unknown'];
        
        dequeCache.set(url, result);
        return result;

    } catch (error) {
        // Silently catch timeouts, network errors, or DOM parsing errors
        clearTimeout(timeoutId);
        dequeCache.set(url, ['Unknown']); // Cache the failure so we don't keep timing out
        return ['Unknown'];
    }
}

function getLineNumber(htmlString, snippet) {
    if (!snippet || !htmlString) return 'N/A';
    const index = htmlString.indexOf(snippet);
    if (index === -1) return 'N/A'; 
    return htmlString.substring(0, index).split(/\r\n|\n|\r/).length;
}

async function performAudit(content, isUrl = false) {
    return new Promise(async (resolve, reject) => {
        try {
            let htmlString = content;

            if (isUrl) {
                const response = await fetch(content);
                htmlString = await response.text();
            }

            const virtualConsole = new VirtualConsole();
            virtualConsole.sendTo(console, { omitJSDOMErrors: true });
            virtualConsole.on("jsdomError", (err) => {
                if (err.message.includes("not implemented") && err.message.includes("HTMLCanvasElement")) return; 
                console.error(err);
            });

            const jsdomOptions = { 
                runScripts: "dangerously", 
                resources: "usable", 
                virtualConsole: virtualConsole,
                url: isUrl ? content : "http://localhost/" 
            };

            let dom = new JSDOM(htmlString, jsdomOptions);
            const axeSource = axeCore.source;
            dom.window.eval(axeSource);

            const isSnippet = !isUrl && !content.toLowerCase().includes('<html');
            const baseRules = { 'color-contrast': { enabled: false } };
            const snippetRules = isSnippet ? {
                'document-title': { enabled: false }, 'html-has-lang': { enabled: false },
                'page-has-heading-one': { enabled: false }, 'landmark-one-main': { enabled: false },
                'region': { enabled: false }, 'bypass': { enabled: false }
            } : {};

            const auditOptions = { rules: { ...baseRules, ...snippetRules } };

            dom.window.axe.run(dom.window.document, auditOptions, async (err, results) => {
                if (err) return reject(err);

                const totalElements = Math.max(dom.window.document.querySelectorAll('*').length, 1);
                
                // Calculate Axe core penalty points
                let totalPenaltyPoints = results.violations.reduce((sum, violation) => {
                    const impact = violation.impact || 'unknown';
                    return sum + (impactWeights[impact] * violation.nodes.length);
                }, 0);

                // Use Promise.all to fetch all Deque URLs concurrently
                let mappedViolations = await Promise.all(results.violations.map(async violation => {
                    const impact = violation.impact || 'unknown';
                    const scrapedDisabilities = await fetchDisabilitiesFromDeque(violation.helpUrl);

                    let v = {
                        id: violation.id,
                        impact: impact, 
                        description: violation.description,
                        help: violation.help,
                        helpUrl: violation.helpUrl,
                        disabilities: scrapedDisabilities,
                        tags: violation.tags.filter(tag => tag.startsWith('wcag')),
                        nodes: violation.nodes.map(node => ({ 
                            html: node.html, 
                            failureSummary: node.failureSummary,
                            lineNumber: getLineNumber(htmlString, node.html)
                        }))
                    };

                    if (v.id === 'image-alt') v.description += ' Unless this is a decorative image, it needs descriptive text. If the image itself has text, include it in quotes.';
                    return v;
                }));

                // --- CUSTOM A11YAUDIT RULESET ---

                // 1. Empty Alt Review
                const emptyAltImages = dom.window.document.querySelectorAll('img[alt=""]');
                if (emptyAltImages.length > 0) {
                    totalPenaltyPoints += (impactWeights['moderate'] * emptyAltImages.length);
                    mappedViolations.push({
                        id: 'custom-empty-alt-review',
                        impact: 'moderate',
                        description: 'This image has an empty alt attribute (alt=""). Manual verification needed.',
                        help: 'Verify decorative image usage.',
                        helpUrl: 'https://www.w3.org/WAI/tutorials/images/decorative/',
                        disabilities: ['Blind'], 
                        tags: ['wcag2a', 'wcag111', 'manual-review'],
                        nodes: Array.from(emptyAltImages).map(img => ({ 
                            html: img.outerHTML, 
                            failureSummary: 'Manual review required.',
                            lineNumber: getLineNumber(htmlString, img.outerHTML)
                        }))
                    });
                }

                // 2. Vague Links ("Click Here")
                const vagueLinkText = ['click here', 'read more', 'learn more', 'more info', 'link'];
                const badLinks = Array.from(dom.window.document.querySelectorAll('a')).filter(link => {
                    return vagueLinkText.includes(link.textContent.trim().toLowerCase());
                });
                if (badLinks.length > 0) {
                    totalPenaltyPoints += (impactWeights['moderate'] * badLinks.length);
                    mappedViolations.push({
                        id: 'custom-vague-link',
                        impact: 'moderate',
                        description: 'Link text must clearly describe the destination. Generic phrases provide no context to screen reader users.',
                        help: 'Avoid generic link text like "Click Here".',
                        helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html',
                        disabilities: ['Blind', 'Cognitive'], 
                        tags: ['wcag2a', 'wcag244', 'best-practice'],
                        nodes: badLinks.map(link => ({ 
                            html: link.outerHTML, 
                            failureSummary: 'Link text is too vague.',
                            lineNumber: getLineNumber(htmlString, link.outerHTML)
                        }))
                    });
                }

                // 3. ARIA Stutter (Over-engineering)
                const elementsWithTitles = dom.window.document.querySelectorAll('[title], [aria-label]');
                const stutterElements = Array.from(elementsWithTitles).filter(el => {
                    const text = el.textContent.trim().toLowerCase();
                    const title = (el.getAttribute('title') || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
                    return (text && (title === text || aria === text));
                });
                if (stutterElements.length > 0) {
                    totalPenaltyPoints += (impactWeights['minor'] * stutterElements.length);
                    mappedViolations.push({
                        id: 'custom-aria-stutter',
                        impact: 'minor',
                        description: 'The aria-label or title exactly matches the visible text. Screen readers will read this text twice in a row.',
                        help: 'Remove redundant aria-labels or titles.',
                        helpUrl: 'https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA14',
                        disabilities: ['Blind'], 
                        tags: ['best-practice', 'aria-redundancy'],
                        nodes: stutterElements.map(el => ({ 
                            html: el.outerHTML, 
                            failureSummary: 'Redundant ARIA attribute causes stutter.',
                            lineNumber: getLineNumber(htmlString, el.outerHTML)
                        }))
                    });
                }

                // 4. Semantic Deprecation (<b> and <i> tags)
                const outdatedTags = dom.window.document.querySelectorAll('b, i');
                if (outdatedTags.length > 0) {
                    totalPenaltyPoints += (impactWeights['minor'] * outdatedTags.length);
                    mappedViolations.push({
                        id: 'custom-semantic-deprecation',
                        impact: 'minor',
                        description: 'Visual tags like <code>&lt;b&gt;</code> and <code>&lt;i&gt;</code> provide no semantic meaning to assistive technologies.',
                        help: 'Use <code>&lt;strong&gt;</code> for importance and <code>&lt;em&gt;</code> for emphasis.',
                        helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/strong',
                        disabilities: ['Blind', 'Cognitive'], 
                        tags: ['best-practice', 'semantic-html'],
                        nodes: Array.from(outdatedTags).map(tag => ({ 
                            html: tag.outerHTML, 
                            failureSummary: 'Deprecated visual tag used.',
                            lineNumber: getLineNumber(htmlString, tag.outerHTML)
                        }))
                    });
                }

                // 5. Redundant Adjacent Links
                const allLinks = dom.window.document.querySelectorAll('a[href]');
                const redundantLinks = [];
                for (let i = 0; i < allLinks.length - 1; i++) {
                    if (allLinks[i].href === allLinks[i+1].href) {
                        redundantLinks.push(allLinks[i]);
                    }
                }
                if (redundantLinks.length > 0) {
                    totalPenaltyPoints += (impactWeights['minor'] * redundantLinks.length);
                    mappedViolations.push({
                        id: 'custom-redundant-links',
                        impact: 'minor',
                        description: 'Adjacent links pointing to the same destination force screen reader users to navigate past redundant stops.',
                        help: 'Combine adjacent links to the same destination.',
                        helpUrl: 'https://www.w3.org/WAI/WCAG22/Techniques/html/H2',
                        disabilities: ['Blind', 'Mobility'], 
                        tags: ['wcag2a', 'wcag244', 'best-practice'],
                        nodes: redundantLinks.map(link => ({ 
                            html: link.outerHTML, 
                            failureSummary: 'Redundant adjacent link.',
                            lineNumber: getLineNumber(htmlString, link.outerHTML)
                        }))
                    });
                }

                const rawScore = 100 - ((totalPenaltyPoints / totalElements) * 100);
                resolve({ score: Math.max(0, Math.round(rawScore)), totalElements: totalElements, violations: mappedViolations });
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
            const filePromises = req.files.map(async (file) => {
                const htmlContent = file.buffer.toString('utf8');
                const looksLikeHTML = /<[a-z][\s\S]*>/i.test(htmlContent.trim());
                if (!looksLikeHTML) {
                    return { sourceFile: file.originalname, score: null, error: `"${file.originalname}" does not appear to be an HTML file.` };
                }
                const report = await performAudit(htmlContent, false);
                return { sourceFile: file.originalname, ...report };
            });
            const processedReports = await Promise.all(filePromises);
            fileReports.push(...processedReports);
            totalProjectScore += processedReports.reduce((sum, report) => sum + report.score, 0);
        } else if (urlInput.startsWith('http')) {
            const report = await performAudit(urlInput, true);
            fileReports.push({ sourceFile: urlInput, ...report });
            totalProjectScore += report.score;
        } else if (urlInput.trim().length > 0) {
            const looksLikeHTML = /<[a-z][\s\S]*>/i.test(urlInput.trim());
            if (!looksLikeHTML) {
                return res.status(400).json({ error: "Invalid input: this doesn't appear to be HTML. Please paste an HTML snippet." });
            }
            const report = await performAudit(urlInput, false);
            fileReports.push({ sourceFile: "Snippet", ...report });
            totalProjectScore += report.score;
        } else {
            return res.status(400).json({ error: "Please provide a valid URL, snippet, or files." });
        }

        const averageScore = fileReports.length > 0 ? Math.round(totalProjectScore / fileReports.length) : 0;
        res.json({ status: "success", aggregateScore: averageScore, files: fileReports });
    } catch (error) {
        console.error("❌ Engine Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`A11yAudit Engine on port ${PORT}`));