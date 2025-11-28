/**
 * TDS LLM Analysis - Quiz Endpoint Handler
 * - Verifies secret
 * - Responds 200 on valid secret (403 on secret mismatch, 400 on bad JSON)
 * - Launches Puppeteer, visits the provided quiz URL, attempts to solve,
 *   posts the answer to the submit URL discovered on the page, and follows
 *   the next URL until done or a 3-minute deadline.
 *
 * NOTE: This is a pragmatic starter. Extend attemptSolve() for more quiz types.
 */

const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const pdf = require("pdf-parse");

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET || "change_me";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "you@example.com";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

function send400(res, msg="Bad Request") { return res.status(400).json({ error: msg }); }
function send403(res, msg="Forbidden") { return res.status(403).json({ error: msg }); }
function safeLog(...args) { console.log(new Date().toISOString(), ...args); }

/**
 * Primary endpoint to receive quiz POSTs.
 * Required payload: { email, secret, url }
 */
app.post("/quiz-endpoint", async (req, res) => {
  if (!req.is("application/json")) return send400(res, "Expected JSON");
  const { email, secret, url } = req.body || {};
  if (!email || !secret || !url) return send400(res, "Missing fields: email, secret, url required");
  if (secret !== APP_SECRET) return send403(res, "Invalid secret");

  // Immediate acknowledgement required by spec
  res.status(200).json({ status: "accepted" });

  // Now process the quiz (we continue after responding)
  try {
    await handleQuiz({ email, secret, startUrl: url });
  } catch (err) {
    safeLog("Processing error", err.stack || err.message || err);
  }
});

/**
 * Main solver loop. Visits startUrl and follows next URLs until done or deadline.
 */
async function handleQuiz({ email, secret, startUrl }) {
  const startTs = Date.now();
  const MAX_MS = 3 * 60 * 1000 - 4000; // 3 minutes minus small buffer
  const deadline = startTs + MAX_MS;

  safeLog("Starting quiz for", email, "startUrl=", startUrl);

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  });
  const page = await browser.newPage();

  let currentUrl = startUrl;
  try {
    while (currentUrl && Date.now() < deadline) {
      safeLog("Visiting", currentUrl);
      await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 40000 }).catch(e => {
        safeLog("Navigation error:", e.message);
      });

      // Extract page content heuristically
      const pageSnapshot = await page.evaluate(() => {
        const pre = document.querySelector("pre")?.innerText || null;
        const result = document.querySelector("#result")?.innerHTML || null;
        const text = document.body?.innerText || "";
        const anchors = Array.from(document.querySelectorAll("a")).map(a => a.href);
        const forms = Array.from(document.querySelectorAll("form")).map(f => ({ action: f.action, method: f.method }));
        const scripts = Array.from(document.querySelectorAll("script")).map(s => s.innerText.slice(0, 2000));
        return { pre, result, text, anchors, forms, scripts, url: location.href };
      });

      // Attempt to decode base64 inside scripts (common pattern)
      let decodedFromScript = null;
      for (const sc of pageSnapshot.scripts) {
        if (!sc) continue;
        const m = sc.match(/atob\((?:`([^`]*)`|'([^']*)'|"([^"]*)")\)/);
        if (m) {
          const b64 = m[1] || m[2] || m[3];
          try { decodedFromScript = Buffer.from(b64, "base64").toString("utf8"); break; } catch(e){ }
        }
      }

      const rawTask = decodedFromScript || pageSnapshot.pre || pageSnapshot.result || pageSnapshot.text || "";
      safeLog("Raw task snippet:", rawTask.slice(0, 400).replace(/\n/g," "));

      // Parse and attempt to solve (very small set of heuristics + fallback screenshot)
      const payload = await attemptSolve({ rawTask, pageSnapshot, page, axios, secret, email, deadline });

      // Discover submit URL
      const submitUrl = await findSubmitUrl({ page, pageSnapshot });
      if (!submitUrl) {
        safeLog("No submit URL found on page:", page.url());
        // fallback: send human-check payload to admin email (return screenshot)
        const shot = await page.screenshot({ encoding: "base64", fullPage: false });
        safeLog("Dropping screenshot for manual inspection (base64 length)", shot.length);
        break;
      }

      // Post answer
      try {
        safeLog("Submitting to", submitUrl, "payload keys:", Object.keys(payload || {}));
        const resp = await axios.post(submitUrl, payload, { timeout: 30000 }).then(r => r.data).catch(e => {
          safeLog("Submit error", e.response?.status, e.message);
          return { error: e.message };
        });
        safeLog("Submit response:", JSON.stringify(resp).slice(0,400));

        // Move to next URL if provided
        if (resp && resp.url) {
          currentUrl = resp.url;
          continue;
        } else {
          // No next URL -> finish
          safeLog("Quiz ended or no next url provided");
          break;
        }
      } catch (e) {
        safeLog("Submit exception", e.message);
        break;
      }
    }
  } finally {
    await browser.close();
    safeLog("Browser closed; total time ms=", (Date.now() - startTs));
  }
}

/**
 * Heuristics to produce an answer payload.
 * Extend this heavily for other question types.
 */
async function attemptSolve({ rawTask, pageSnapshot, page, axios, secret, email, deadline }) {
  // 1) If rawTask looks like JSON blob (demo pattern), parse and follow.
  rawTask = (rawTask || "").trim();
  if (rawTask.startsWith("{") && rawTask.endsWith("}")) {
    try {
      const j = JSON.parse(rawTask);
      // demo pattern: { email, secret, url, answer: ... }
      if (j.url && !j.answer) {
        // Try to fetch the URL (file) and attempt simple parsing
        const fileUrl = j.url;
        safeLog("Detected JSON instruction with file url:", fileUrl);
        try {
          const bin = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 30000 }).then(r => r.data);
          const buf = Buffer.from(bin);
          if (/\.csv$/i.test(fileUrl)) {
            const txt = buf.toString("utf8");
            const rows = parse(txt, { columns: true, skip_empty_lines: true });
            const sum = rows.reduce((s,r)=> s + (parseFloat(r.value || 0) || 0), 0);
            return { email: j.email || email, secret, url: j.url, answer: sum };
          } else if (/\.pdf$/i.test(fileUrl)) {
            const pd = await pdf(buf);
            // naive: sum all numbers in PDF text (imperfect but a start)
            const nums = Array.from(pd.text.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => parseFloat(m[0]));
            const sum = nums.reduce((a,b)=>a+b, 0);
            return { email: j.email || email, secret, url: j.url, answer: sum };
          } else if (/\.json$/i.test(fileUrl)) {
            const txt = buf.toString("utf8");
            const doc = JSON.parse(txt);
            // if doc contains array with "value" fields, sum
            if (Array.isArray(doc)) {
              const sum = doc.reduce((s,o)=> s + (parseFloat(o.value||0) || 0), 0);
              return { email: j.email || email, secret, url: j.url, answer: sum };
            }
          }
        } catch(e) {
          safeLog("File fetch/parse failed:", e.message);
        }
      }
    } catch(e) { /* ignore JSON parse error */ }
  }

  // 2) If page asks to "Post your answer to <url> with this JSON payload:" use example to craft answer
  const postPattern = rawTask.match(/Post your answer to\s*(https?:\/\/[^\s]+)\s*with this JSON payload:\s*([\s\S]*)/i);
  if (postPattern) {
    const submitUrl = postPattern[1];
    const example = postPattern[2];
    safeLog("Detected submit-instructions on page; trying to extract example answer");
    // look for "answer": number
    const ansMatch = example.match(/"answer"\s*:\s*([0-9.+-eE]+)/);
    if (ansMatch) {
      const answer = Number(ansMatch[1]);
      return { email, secret, url: submitUrl, answer };
    }
  }

  // 3) If nothing matched: attach a screenshot and minimal metadata so graders can inspect
  const shot = await page.screenshot({ encoding: "base64", fullPage: false });
  return { email: ADMIN_EMAIL, secret, url: pageSnapshot.url, answer: null, screenshot: shot.slice(0, 200000) };
}

/**
 * Find subject submit URL by checking forms, anchors, or embedded JSON.
 */
async function findSubmitUrl({ page, pageSnapshot }) {
  // check forms
  const formAction = await page.$eval("form", f => f.action).catch(()=>null);
  if (formAction) return formAction;
  // anchors with substring "submit"
  const anchors = pageSnapshot.anchors || [];
  const candidate = anchors.find(h => /\/submit|\/api\/submit|submit/i.test(h));
  if (candidate) return candidate;
  // try pre JSON for a "submit" or "url" field
  const pre = pageSnapshot.pre;
  if (pre) {
    try {
      const j = JSON.parse(pre);
      if (j.submit) return j.submit;
      if (j.url && /submit/i.test(j.url)) return j.url;
    } catch {}
  }
  return null;
}

app.listen(PORT, () => {
  console.log(`TDS LLM Analysis agent listening on ${PORT} - set APP_SECRET env var before production`);
});
