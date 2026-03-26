import { AREA_UNIVERSE } from "../config/universe.js";
import {
  extractJsonText,
  normalizeUrl,
  normalizeWhitespace,
  truncate
} from "./utils.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 3);
const OPENAI_RETRY_BASE_MS = Number(process.env.OPENAI_RETRY_BASE_MS || 1500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function buildOpenAIError({ scope, status, body, requestId, attempt }) {
  const suffix = requestId ? ` request_id=${requestId}` : "";
  return new Error(`${scope} failed on attempt ${attempt}: ${status} ${body}${suffix}`);
}

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
    `Suggested search queries: ${(company.searchSeedQueries || []).join(" | ") || "none provided"}`,
    `Target area tags: ${AREA_UNIVERSE.join(", ")}`,
    "",
    "Task:",
    "1. Use the official career URLs and page snapshots first.",
    "2. Use web search if needed to confirm or discover currently active openings.",
    "3. Focus only on Stockholm-area roles: Stockholm, Solna, Sundbyberg, or clearly Stockholm-based hybrid roles.",
    "4. Do not include generic Sweden, Nordics, or multi-location roles unless Stockholm is explicitly listed.",
    "5. Focus on finance roles relevant to quant, trading, markets, treasury, research, risk, analytics or data science inside finance firms.",
    "6. Prefer official company or ATS job URLs.",
    "7. Only include junior-friendly roles. Exclude roles that are senior, lead, principal, head, manager, director, staff, expert, or that clearly require more than 1 year of prior experience.",
    "8. If a role explicitly asks for 2 or more years of experience, exclude it.",
    "9. For the target companies, prefer recall over precision for junior Stockholm finance roles: if a role looks plausibly connected to quant, risk, treasury, markets, trading, research, analytics or data science, include it rather than omit it.",
    "10. If an application deadline is visible, include it in expires_at.",
    "11. Return at most the requested number of jobs.",
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
            expires_at: "YYYY-MM-DD or null",
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
    expires_at: job.expires_at || null,
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
    expires_at: job.expires_at || null,
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

async function callResponsesApi({ scope, input, tools, model = DEFAULT_MODEL }) {
  let lastError;

  for (let attempt = 1; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    const payload = {
      model,
      input,
      max_output_tokens: 4_000
    };

    if (tools?.length) {
      payload.tools = tools;
    }

    try {
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
      const requestId = response.headers.get("x-request-id");

      if (!response.ok) {
        const error = buildOpenAIError({
          scope,
          status: response.status,
          body: raw,
          requestId,
          attempt
        });

        if (!isRetryableStatus(response.status) || attempt === OPENAI_MAX_RETRIES) {
          throw error;
        }

        lastError = error;
        const delay = OPENAI_RETRY_BASE_MS * 2 ** (attempt - 1);
        await sleep(delay);
        continue;
      }

      return JSON.parse(raw);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === OPENAI_MAX_RETRIES) {
        throw lastError;
      }
      const delay = OPENAI_RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError || new Error(`${scope} failed after retries.`);
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

  const input = buildPrompt({ company, snapshots, maxJobsPerCompany });

  try {
    const json = await callResponsesApi({
      scope: `OpenAI request for ${company.name}`,
      input,
      tools: [{ type: "web_search" }],
      model
    });
    const text = extractResponseText(json);
    const parsed = JSON.parse(extractJsonText(text));
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;

    if (!Array.isArray(jobs)) {
      throw new Error(`OpenAI response for ${company.name} did not contain a jobs array.`);
    }

    return jobs.map((job) => normalizeJob(job, company));
  } catch (primaryError) {
    const fallbackJson = await callResponsesApi({
      scope: `OpenAI fallback request for ${company.name}`,
      input: [
        buildPrompt({ company, snapshots, maxJobsPerCompany }),
        "",
        "Fallback mode: do not use web search. Extract likely current matching jobs only from the provided official page snapshots. If the snapshots do not show enough evidence, return {\"jobs\":[]}."
      ].join("\n"),
      tools: [],
      model
    });

    const text = extractResponseText(fallbackJson);
    const parsed = JSON.parse(extractJsonText(text));
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;

    if (!Array.isArray(jobs)) {
      throw primaryError;
    }

    return jobs.map((job) => normalizeJob(job, company));
  }
}

export async function discoverExternalJobs({
  excludedCompanyNames,
  maxJobs = 15,
  model = DEFAULT_MODEL
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const json = await callResponsesApi({
    scope: "OpenAI external discovery",
    input: [
      "You are helping a daily Stockholm finance job scanner.",
      "Find active finance jobs in Stockholm outside the already-tracked company list.",
      "Focus on banks, brokers, exchanges, hedge funds, market infrastructure, asset managers and similar financial firms.",
      "Focus on roles related to quant, trading, markets, treasury, research, risk, analytics, model validation and data science.",
      "Focus only on Stockholm-area roles: Stockholm, Solna, Sundbyberg, or clearly Stockholm-based hybrid roles.",
      "Only include junior-friendly roles. Exclude roles that are senior, lead, principal, head, manager, director, staff, expert, or that clearly require more than 1 year of prior experience.",
      "If a role explicitly asks for 2 or more years of experience, exclude it.",
      `Exclude these companies because they are already tracked directly: ${excludedCompanyNames.join(", ")}`,
      `Return at most ${maxJobs} jobs.`,
      "Use official company or ATS job URLs whenever possible.",
      "Prefer recall over precision: if a Stockholm finance role looks plausibly relevant, include it rather than omit it.",
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
              expires_at: "YYYY-MM-DD or null",
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
    ].join("\n"),
    tools: [{ type: "web_search" }],
    model
  });

  const text = extractResponseText(json);
  const parsed = JSON.parse(extractJsonText(text));
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;

  if (!Array.isArray(jobs)) {
    throw new Error("OpenAI external discovery did not contain a jobs array.");
  }

  return jobs.map((job) => normalizeExternalJob(job));
}
