import { AREA_UNIVERSE } from "../config/universe.js";
import {
  extractJsonText,
  normalizeUrl,
  normalizeWhitespace,
  truncate
} from "./utils.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function buildPrompt({ company, snapshots, maxJobsPerCompany }) {
  const snapshotText = snapshots
    .map((snapshot, index) => {
      const status = snapshot.status ?? "n/a";
      const excerpt = snapshot.excerpt || "No content captured.";
      return [
        `Snapshot ${index + 1}`,
        `Requested URL: ${snapshot.requested_url}`,
        `Final URL: ${snapshot.final_url}`,
        `HTTP status: ${status}`,
        `Excerpt: ${excerpt}`
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are helping a daily Stockholm finance job scanner.",
    `Company: ${company.name}`,
    `Priority: ${company.priority}`,
    `Official career URLs: ${company.careerUrls.join(", ")}`,
    `Location signals: ${company.stockholmSignals.join(", ")}`,
    `Search hints: ${company.searchHints.join(", ")}`,
    `Target area tags: ${AREA_UNIVERSE.join(", ")}`,
    "",
    "Task:",
    "1. Use the official career URLs and page snapshots first.",
    "2. Use web search if needed to confirm or discover currently active openings.",
    "3. Include only jobs that appear active right now.",
    "4. Focus on Stockholm, hybrid Stockholm, or Sweden/Nordics roles that are clearly anchored in Stockholm.",
    "5. Focus on finance roles relevant to quant, trading, markets, treasury, research, risk, analytics or data science inside finance firms.",
    "6. Prefer official company or ATS job URLs.",
    "7. Exclude generic software roles with no clear finance connection.",
    "8. Return at most the requested number of jobs.",
    "",
    `Maximum jobs to return: ${maxJobsPerCompany}`,
    "",
    "Return JSON only with this shape:",
    JSON.stringify(
      {
        jobs: [
          {
            title: "string",
            company: company.name,
            apply_url: "string",
            source_url: "string",
            location: "string",
            location_type: "onsite|hybrid|remote|unknown",
            team: "string",
            posted_at: "YYYY-MM-DD or null",
            summary: "string",
            area_tags: ["one_or_more_from_area_universe"],
            stockholm_match: true,
            finance_match: true,
            relevance_score: 0,
            why_relevant: "short reason",
            confidence: 0.0
          }
        ]
      },
      null,
      2
    ),
    "",
    "If you cannot find any matching active roles, return {\"jobs\":[]}.",
    "",
    "Page snapshots:",
    snapshotText
  ].join("\n");
}

function extractResponseText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const content of item.content || []) {
        if (typeof content.text === "string") {
          chunks.push(content.text);
        } else if (content.text && typeof content.text.value === "string") {
          chunks.push(content.text.value);
        }
      }
    }
  }

  return chunks.join("\n").trim();
}

function normalizeJob(job, company) {
  return {
    company: company.name,
    company_id: company.id,
    title: normalizeWhitespace(job.title),
    apply_url: normalizeUrl(job.apply_url || job.source_url),
    source_url: normalizeUrl(job.source_url || job.apply_url),
    location: normalizeWhitespace(job.location),
    location_type: normalizeWhitespace(job.location_type || "unknown").toLowerCase(),
    team: normalizeWhitespace(job.team || ""),
    posted_at: job.posted_at || null,
    summary: truncate(normalizeWhitespace(job.summary || ""), 400),
    area_tags: Array.isArray(job.area_tags)
      ? job.area_tags.filter((tag) => AREA_UNIVERSE.includes(tag))
      : [],
    stockholm_match: Boolean(job.stockholm_match),
    finance_match: Boolean(job.finance_match),
    relevance_score: Number(job.relevance_score || 0),
    why_relevant: truncate(normalizeWhitespace(job.why_relevant || ""), 220),
    confidence: Number(job.confidence || 0)
  };
}

function normalizeExternalJob(job) {
  return {
    company: normalizeWhitespace(job.company),
    company_id: normalizeWhitespace(job.company_id || ""),
    title: normalizeWhitespace(job.title),
    apply_url: normalizeUrl(job.apply_url || job.source_url),
    source_url: normalizeUrl(job.source_url || job.apply_url),
    location: normalizeWhitespace(job.location),
    location_type: normalizeWhitespace(job.location_type || "unknown").toLowerCase(),
    team: normalizeWhitespace(job.team || ""),
    posted_at: job.posted_at || null,
    summary: truncate(normalizeWhitespace(job.summary || ""), 400),
    area_tags: Array.isArray(job.area_tags)
      ? job.area_tags.filter((tag) => AREA_UNIVERSE.includes(tag))
      : [],
    stockholm_match: Boolean(job.stockholm_match),
    finance_match: Boolean(job.finance_match),
    relevance_score: Number(job.relevance_score || 0),
    why_relevant: truncate(normalizeWhitespace(job.why_relevant || ""), 220),
    confidence: Number(job.confidence || 0),
    discovery_method: "openai:global_search"
  };
}

export async function discoverJobsForCompany({
  company,
  snapshots,
  maxJobsPerCompany = 10,
  model = DEFAULT_MODEL
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const payload = {
    model,
    tools: [{ type: "web_search" }],
    input: buildPrompt({ company, snapshots, maxJobsPerCompany }),
    max_output_tokens: 4_000
  };

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed for ${company.name}: ${response.status} ${raw}`);
  }

  const json = JSON.parse(raw);
  const text = extractResponseText(json);
  const parsed = JSON.parse(extractJsonText(text));
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;

  if (!Array.isArray(jobs)) {
    throw new Error(`OpenAI response for ${company.name} did not contain a jobs array.`);
  }

  return jobs.map((job) => normalizeJob(job, company));
}

export async function discoverExternalJobs({
  excludedCompanyNames,
  maxJobs = 15,
  model = DEFAULT_MODEL
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const payload = {
    model,
    tools: [{ type: "web_search" }],
    max_output_tokens: 4_000,
    input: [
      "You are helping a daily Stockholm finance job scanner.",
      "Find active finance jobs in Stockholm outside the already-tracked company list.",
      "Focus on banks, brokers, exchanges, hedge funds, market infrastructure, asset managers and similar financial firms.",
      "Focus on roles related to quant, trading, markets, treasury, research, risk, analytics, model validation and data science.",
      `Exclude these companies because they are already tracked directly: ${excludedCompanyNames.join(", ")}`,
      `Return at most ${maxJobs} jobs.`,
      "Use official company or ATS job URLs whenever possible.",
      "Only include jobs that appear active right now.",
      "Return JSON only with this shape:",
      JSON.stringify(
        {
          jobs: [
            {
              company: "string",
              title: "string",
              apply_url: "string",
              source_url: "string",
              location: "string",
              location_type: "onsite|hybrid|remote|unknown",
              team: "string",
              posted_at: "YYYY-MM-DD or null",
              summary: "string",
              area_tags: ["one_or_more_from_area_universe"],
              stockholm_match: true,
              finance_match: true,
              relevance_score: 0,
              why_relevant: "short reason",
              confidence: 0.0
            }
          ]
        },
        null,
        2
      ),
      "If none are found, return {\"jobs\":[]}.",
      `Allowed area tags: ${AREA_UNIVERSE.join(", ")}`
    ].join("\n")
  };

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI external discovery failed: ${response.status} ${raw}`);
  }

  const json = JSON.parse(raw);
  const text = extractResponseText(json);
  const parsed = JSON.parse(extractJsonText(text));
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;

  if (!Array.isArray(jobs)) {
    throw new Error("OpenAI external discovery did not contain a jobs array.");
  }

  return jobs.map((job) => normalizeExternalJob(job));
}
