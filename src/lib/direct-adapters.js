import { AREA_KEYWORDS, STOCKHOLM_KEYWORDS } from "../config/universe.js";
import { fetchText } from "./http.js";
import {
  normalizeUrl,
  normalizeWhitespace,
  stripHtml,
  truncate,
  uniqueBy
} from "./utils.js";

const MAX_DIRECT_DETAIL_PAGES = Number(process.env.MAX_DIRECT_DETAIL_PAGES || 40);

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractHrefs(html, baseUrl) {
  const matches = [...String(html || "").matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)];
  const urls = [];

  for (const match of matches) {
    const rawHref = match[1];
    if (!rawHref || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) {
      continue;
    }

    try {
      urls.push(new URL(rawHref, baseUrl).toString());
    } catch {
      continue;
    }
  }

  return uniqueBy(urls, (url) => url);
}

function extractAnchors(html, baseUrl) {
  const matches = [...String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const anchors = [];

  for (const [, rawHref, innerHtml] of matches) {
    if (!rawHref || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) {
      continue;
    }

    try {
      anchors.push({
        url: new URL(rawHref, baseUrl).toString(),
        text: normalizeWhitespace(stripHtml(innerHtml))
      });
    } catch {
      continue;
    }
  }

  return anchors;
}

function flattenJsonLdValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenJsonLdValue(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const nested = value["@graph"] ? flattenJsonLdValue(value["@graph"]) : [];
  return [value, ...nested];
}

function extractJsonLdObjects(html) {
  const scripts = [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const objects = [];

  for (const [, rawContent] of scripts) {
    const content = decodeHtmlEntities(rawContent).trim();
    if (!content) {
      continue;
    }

    try {
      const parsed = JSON.parse(content);
      objects.push(...flattenJsonLdValue(parsed));
    } catch {
      continue;
    }
  }

  return objects;
}

function findJobPostingJsonLd(html) {
  return extractJsonLdObjects(html).find((entry) => {
    const type = entry["@type"];
    if (Array.isArray(type)) {
      return type.includes("JobPosting");
    }
    return type === "JobPosting";
  });
}

function extractMetaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["'][^>]*>`, "i")
  ];

  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) {
      return normalizeWhitespace(decodeHtmlEntities(match[1]));
    }
  }

  return "";
}

function extractHeading(html, tagName) {
  const match = String(html || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? normalizeWhitespace(stripHtml(match[1])) : "";
}

function extractFirstParagraph(html) {
  const match = String(html || "").match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return match ? normalizeWhitespace(stripHtml(match[1])) : "";
}

function htmlToLines(html) {
  return decodeHtmlEntities(String(html || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|section|article|header|footer|aside|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function extractLabelValue(lines, label) {
  const normalizedLabel = normalizeWhitespace(label).toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeWhitespace(lines[index]);
    const lower = line.toLowerCase();

    if (lower === normalizedLabel) {
      return normalizeWhitespace(lines[index + 1] || "");
    }

    if (lower.startsWith(`${normalizedLabel}:`)) {
      return normalizeWhitespace(line.slice(label.length + 1));
    }
  }

  return "";
}

function inferLocationType(text) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (haystack.includes("hybrid")) {
    return "hybrid";
  }
  if (haystack.includes("remote")) {
    return "remote";
  }
  if (haystack.includes("onsite")) {
    return "onsite";
  }
  return "unknown";
}

function inferAreaTagsFromText(text) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  return Object.entries(AREA_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => haystack.includes(keyword.toLowerCase())))
    .map(([area]) => area);
}

function inferStockholmMatch(location, fullText, company) {
  const haystack = `${location} ${fullText}`.toLowerCase();
  return [...STOCKHOLM_KEYWORDS, ...(company.stockholmSignals || [])].some((keyword) =>
    haystack.includes(keyword.toLowerCase())
  );
}

function buildJobFromJsonLd(jobPosting, url, company, fallback = {}) {
  const locations = Array.isArray(jobPosting.jobLocation)
    ? jobPosting.jobLocation
    : jobPosting.jobLocation
      ? [jobPosting.jobLocation]
      : [];

  const location = normalizeWhitespace(
    locations
      .map((item) => {
        const address = item?.address || {};
        return [
          item?.name,
          address.addressLocality,
          address.addressRegion,
          address.addressCountry
        ]
          .filter(Boolean)
          .join(", ");
      })
      .filter(Boolean)
      .join(" | ") || fallback.location || ""
  );

  const summary = truncate(
    normalizeWhitespace(stripHtml(jobPosting.description || fallback.summary || "")),
    400
  );
  const team = normalizeWhitespace(
    jobPosting.department ||
      jobPosting.industry ||
      fallback.team ||
      ""
  );
  const joinedText = [jobPosting.title, summary, team, location].join(" ");

  return {
    title: normalizeWhitespace(jobPosting.title || fallback.title || ""),
    company: company.name,
    company_id: company.id,
    apply_url: normalizeUrl(url),
    source_url: normalizeUrl(url),
    location,
    location_type: inferLocationType(
      `${jobPosting.jobLocationType || ""} ${fallback.location_type || ""} ${summary}`
    ),
    team,
    posted_at: jobPosting.datePosted ? String(jobPosting.datePosted).slice(0, 10) : fallback.posted_at || null,
    summary,
    area_tags: uniqueBy(
      [
        ...(Array.isArray(fallback.area_tags) ? fallback.area_tags : []),
        ...inferAreaTagsFromText(joinedText)
      ],
      (tag) => tag
    ),
    stockholm_match: inferStockholmMatch(location, joinedText, company),
    finance_match: true,
    relevance_score: Number(fallback.relevance_score || 0),
    why_relevant: fallback.why_relevant || "",
    confidence: Number(fallback.confidence || 0.75),
    discovery_method: `direct:${company.adapter || "generic"}`
  };
}

function buildFallbackJob({ html, url, company, team, location, posted_at, location_type }) {
  const title = extractHeading(html, "h1");
  const summary = truncate(
    normalizeWhitespace(
      extractMetaContent(html, "description") || extractFirstParagraph(html)
    ),
    400
  );
  const fullText = [title, team, location, summary].join(" ");

  return {
    title,
    company: company.name,
    company_id: company.id,
    apply_url: normalizeUrl(url),
    source_url: normalizeUrl(url),
    location: normalizeWhitespace(location),
    location_type: location_type || inferLocationType(fullText),
    team: normalizeWhitespace(team),
    posted_at: posted_at || null,
    summary,
    area_tags: inferAreaTagsFromText(fullText),
    stockholm_match: inferStockholmMatch(location, fullText, company),
    finance_match: true,
    relevance_score: 0,
    why_relevant: "",
    confidence: 0.55,
    discovery_method: `direct:${company.adapter || "generic"}`
  };
}

async function fetchHtml(url) {
  const response = await fetchText(url, { timeoutMs: 25_000 });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text;
}

async function parseTeamtailorDetail(url, company) {
  const html = await fetchHtml(url);
  const jobPosting = findJobPostingJsonLd(html);
  const lines = htmlToLines(html);
  const pageText = lines.join(" ");
  const team = extractLabelValue(lines, "Department");
  const location = extractLabelValue(lines, "Locations") || extractLabelValue(lines, "Location");
  const locationType = inferLocationType(
    `${extractLabelValue(lines, "Remote status")} ${pageText}`
  );

  if (jobPosting) {
    return buildJobFromJsonLd(jobPosting, url, company, {
      team,
      location,
      location_type: locationType
    });
  }

  return buildFallbackJob({
    html,
    url,
    company,
    team,
    location,
    location_type: locationType
  });
}

async function scanTeamtailor(company) {
  const jobsUrl = company.listingUrls?.[0];
  if (!jobsUrl) {
    return [];
  }

  const html = await fetchHtml(jobsUrl);
  const detailUrls = extractHrefs(html, jobsUrl)
    .filter((url) => url.startsWith(new URL(jobsUrl).origin))
    .filter((url) => /\/jobs\/\d+/.test(url))
    .slice(0, MAX_DIRECT_DETAIL_PAGES);

  const jobs = [];
  for (const detailUrl of detailUrls) {
    try {
      jobs.push(await parseTeamtailorDetail(detailUrl, company));
    } catch {
      continue;
    }
  }

  return uniqueBy(jobs, (job) => job.apply_url);
}

async function parseSebDetail(url, company) {
  const html = await fetchHtml(url);
  const jobPosting = findJobPostingJsonLd(html);
  const lines = htmlToLines(html);
  const pageText = lines.join(" ");
  const team = extractLabelValue(lines, "Categories");
  const location = extractLabelValue(lines, "Location");
  const locationType = inferLocationType(pageText);

  if (jobPosting) {
    return buildJobFromJsonLd(jobPosting, url, company, {
      team,
      location,
      location_type: locationType
    });
  }

  return buildFallbackJob({
    html,
    url,
    company,
    team,
    location,
    location_type: locationType
  });
}

async function scanSeb(company) {
  const seedUrls = company.listingUrls?.length ? company.listingUrls : company.careerUrls;
  const detailUrls = [];

  for (const seedUrl of seedUrls) {
    try {
      const html = await fetchHtml(seedUrl);
      detailUrls.push(
        ...extractHrefs(html, seedUrl).filter((url) =>
          url.includes("/career/find-your-new-job/our-vacant-positions/")
        )
      );
    } catch {
      continue;
    }
  }

  const jobs = [];
  for (const detailUrl of uniqueBy(detailUrls, (url) => url).slice(0, MAX_DIRECT_DETAIL_PAGES)) {
    try {
      jobs.push(await parseSebDetail(detailUrl, company));
    } catch {
      continue;
    }
  }

  return uniqueBy(jobs, (job) => job.apply_url);
}

async function parseNordeaDetail(url, company) {
  const html = await fetchHtml(url);
  const jobPosting = findJobPostingJsonLd(html);
  const lines = htmlToLines(html);
  const pageText = lines.join(" ");

  let location = "";
  const title = extractHeading(html, "h1");
  const locationMatch = pageText.match(new RegExp(`${title}\\s+([^\\n]+?)\\s+Job ID`, "i"));
  if (locationMatch) {
    location = normalizeWhitespace(locationMatch[1]);
  }

  const teamMatch = pageText.match(/Meet the ([^.]+?) team/i);
  const team = teamMatch ? normalizeWhitespace(teamMatch[1]) : "";

  if (jobPosting) {
    return buildJobFromJsonLd(jobPosting, url, company, {
      team,
      location
    });
  }

  return buildFallbackJob({
    html,
    url,
    company,
    team,
    location
  });
}

async function scanNordea(company) {
  const seedUrls = company.listingUrls?.length ? company.listingUrls : company.careerUrls;
  const detailUrls = [];

  for (const seedUrl of seedUrls) {
    try {
      const html = await fetchHtml(seedUrl);
      detailUrls.push(
        ...extractHrefs(html, seedUrl).filter((url) =>
          url.startsWith("https://careers.nordea.com/job/")
        )
      );
      detailUrls.push(
        ...[...String(html).matchAll(/https:\/\/careers\.nordea\.com\/job\/[^"'\\\s<]+/gi)].map((match) => match[0])
      );
    } catch {
      continue;
    }
  }

  const jobs = [];
  for (const detailUrl of uniqueBy(detailUrls, (url) => normalizeUrl(url)).slice(0, MAX_DIRECT_DETAIL_PAGES)) {
    try {
      jobs.push(await parseNordeaDetail(detailUrl, company));
    } catch {
      continue;
    }
  }

  return uniqueBy(jobs, (job) => job.apply_url);
}

async function scanBrummer(company) {
  const careersUrl = company.listingUrls?.[0] || company.careerUrls?.[0];
  if (!careersUrl) {
    return [];
  }

  const html = await fetchHtml(careersUrl);
  const lines = htmlToLines(html);
  const anchors = extractAnchors(html, careersUrl).filter((anchor) => {
    return /ans[oö]k|apply/i.test(anchor.text) && !anchor.url.includes("recruto.se");
  });

  const jobs = [];
  let inOpenRoles = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();

    if (lower.includes("lediga tjänster")) {
      inOpenRoles = true;
      continue;
    }

    if (inOpenRoles && lower.includes("spontanansökan")) {
      break;
    }

    if (!inOpenRoles) {
      continue;
    }

    const nextLine = normalizeWhitespace(lines[index + 1] || "");
    if (!line || !nextLine) {
      continue;
    }

    const applyAnchor = anchors[jobs.length];
    if (!applyAnchor) {
      break;
    }

    jobs.push({
      title: line,
      company: company.name,
      company_id: company.id,
      apply_url: normalizeUrl(applyAnchor.url),
      source_url: normalizeUrl(careersUrl),
      location: "Stockholm",
      location_type: "unknown",
      team: "",
      posted_at: null,
      summary: truncate(nextLine, 400),
      area_tags: inferAreaTagsFromText(`${line} ${nextLine}`),
      stockholm_match: true,
      finance_match: true,
      relevance_score: 0,
      why_relevant: "",
      confidence: 0.7,
      discovery_method: "direct:brummer"
    });

    index += 2;
  }

  return uniqueBy(jobs, (job) => job.apply_url);
}

const DIRECT_ADAPTERS = {
  teamtailor: scanTeamtailor,
  seb: scanSeb,
  nordea: scanNordea,
  brummer: scanBrummer
};

export async function discoverDirectJobs(company) {
  const adapter = DIRECT_ADAPTERS[company.adapter];
  if (!adapter) {
    return [];
  }
  return adapter(company);
}
