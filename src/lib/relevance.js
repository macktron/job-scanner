import { AREA_KEYWORDS, STOCKHOLM_KEYWORDS } from "../config/universe.js";
import { PERSONAL_PROFILE } from "../config/profile.js";
import { clamp, normalizeWhitespace } from "./utils.js";

const RECENTLY_EXPIRED_GRACE_DAYS = Number(process.env.RECENTLY_EXPIRED_GRACE_DAYS || 14);
const JUNIOR_ONLY = String(process.env.JUNIOR_ONLY || "true").toLowerCase() !== "false";
const MAX_EXPERIENCE_YEARS = Number(process.env.MAX_EXPERIENCE_YEARS || 1);
const HIGH_PRIORITY_COMPANIES = new Set([
  "seb",
  "nordea",
  "nordnet",
  "avanza",
  "handelsbanken",
  "swedbank",
  "lynx_asset_management",
  "brummer_partners"
]);

function keywordHits(text, keywords) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
}

function isFreshEnough(job) {
  if (!job.expires_at) {
    return true;
  }

  const expiresAt = new Date(`${job.expires_at}T23:59:59Z`);
  if (Number.isNaN(expiresAt.getTime())) {
    return true;
  }

  const cutoff = new Date(expiresAt.getTime() + RECENTLY_EXPIRED_GRACE_DAYS * 24 * 60 * 60 * 1000);
  return Date.now() <= cutoff.getTime();
}

function getText(job) {
  return normalizeWhitespace([
    job.title,
    job.team,
    job.summary,
    job.why_relevant
  ].join(" ")).toLowerCase();
}

function extractRequiredYears(text) {
  const patterns = [
    /at least\s+(\d+)\+?\s+years?/gi,
    /minimum\s+(\d+)\+?\s+years?/gi,
    /(\d+)\+?\s+years?\s+of\s+experience/gi,
    /(\d+)-(\d+)\s+years?\s+of\s+experience/gi,
    /(\d+)\s*-\s*(\d+)\s+years?\s+experience/gi
  ];

  let maxYears = 0;

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const years = match[2] ? Number(match[2]) : Number(match[1]);
      if (Number.isFinite(years)) {
        maxYears = Math.max(maxYears, years);
      }
    }
  }

  return maxYears;
}

function isJuniorFriendly(job) {
  if (!JUNIOR_ONLY) {
    return true;
  }

  const text = getText(job);

  const explicitJuniorSignals = [
    "junior",
    "graduate",
    "trainee",
    "intern",
    "internship",
    "entry level",
    "entry-level",
    "new graduate"
  ];

  const seniorSignals = [
    "senior",
    "lead",
    "principal",
    "staff engineer",
    "head of",
    "director",
    "manager",
    "vp ",
    "vice president",
    "expert",
    "specialist"
  ];

  if (seniorSignals.some((signal) => text.includes(signal))) {
    return false;
  }

  const requiredYears = extractRequiredYears(text);
  if (requiredYears > MAX_EXPERIENCE_YEARS) {
    return false;
  }

  if (explicitJuniorSignals.some((signal) => text.includes(signal))) {
    return true;
  }

  const softSeniorPhrases = [
    "proven track record",
    "extensive experience",
    "deep expertise",
    "highly experienced",
    "subject matter expert"
  ];

  if (softSeniorPhrases.some((signal) => text.includes(signal))) {
    return false;
  }

  return true;
}

export function enrichJob(job, company, minScore) {
  const combinedText = [
    job.title,
    job.team,
    job.summary,
    job.location,
    job.why_relevant,
    ...(job.area_tags || [])
  ].join(" ");

  const stockholmHits = keywordHits(combinedText, [
    ...STOCKHOLM_KEYWORDS,
    ...(company.stockholmSignals || [])
  ]);

  const areaHits = Object.values(AREA_KEYWORDS).reduce((sum, keywords) => {
    return sum + Math.min(keywordHits(combinedText, keywords), 2);
  }, 0);

  const areaPreferenceBonus = [...new Set(job.area_tags || [])].reduce((sum, areaTag) => {
    return sum + Number(PERSONAL_PROFILE.areaWeights[areaTag] || 0);
  }, 0);

  const profileKeywordBonus = Object.entries(PERSONAL_PROFILE.keywordWeights).reduce(
    (sum, [keyword, weight]) => {
      return sum + (combinedText.toLowerCase().includes(keyword) ? weight : 0);
    },
    0
  );

  const negativeKeywordPenalty = Object.entries(PERSONAL_PROFILE.softNegativeKeywordWeights).reduce(
    (sum, [keyword, weight]) => {
      return sum + (combinedText.toLowerCase().includes(keyword) ? weight : 0);
    },
    0
  );

  const companyBonus = company.priority === "high" ? 5 : 0;
  const companyPreferenceBonus = Number(PERSONAL_PROFILE.companyWeights[company.id] || 0);
  const stockBonus = job.stockholm_match || stockholmHits > 0 ? 10 : 0;
  const financeBonus = job.finance_match ? 10 : 0;
  const areaBonus = Math.min(areaHits * 2, 12);
  const finalScore = clamp(
    Math.round(
      Number(job.relevance_score || 0) +
        companyBonus +
        companyPreferenceBonus +
        stockBonus +
        financeBonus +
        areaBonus +
        areaPreferenceBonus +
        profileKeywordBonus +
        negativeKeywordPenalty
    ),
    0,
    100
  );

  return {
    ...job,
    stockholm_match: job.stockholm_match || stockholmHits > 0,
    finance_match: Boolean(job.finance_match),
    profile_score_breakdown: {
      company_preference_bonus: companyPreferenceBonus,
      area_preference_bonus: areaPreferenceBonus,
      profile_keyword_bonus: profileKeywordBonus,
      negative_keyword_penalty: negativeKeywordPenalty
    },
    relevance_score: finalScore,
    matches_minimum_score: finalScore >= minScore
  };
}

export function isRelevantJob(job, minScore) {
  if (!job.title || !job.apply_url) {
    return false;
  }

  if (!isJuniorFriendly(job)) {
    return false;
  }

  if (!job.stockholm_match) {
    return false;
  }

  if (!isFreshEnough(job)) {
    return false;
  }

  const hasTargetArea = Array.isArray(job.area_tags) && job.area_tags.length > 0;
  const companyIsFinanceTarget = HIGH_PRIORITY_COMPANIES.has(job.company_id);

  if (!job.finance_match && !hasTargetArea && !companyIsFinanceTarget) {
    return false;
  }

  const adjustedThreshold = companyIsFinanceTarget ? Math.max(minScore - 10, 45) : minScore;
  return Number(job.relevance_score || 0) >= adjustedThreshold;
}
