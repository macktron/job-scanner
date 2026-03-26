import { AREA_KEYWORDS, STOCKHOLM_KEYWORDS } from "../config/universe.js";
import { PERSONAL_PROFILE } from "../config/profile.js";
import { clamp, normalizeWhitespace } from "./utils.js";

function keywordHits(text, keywords) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
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

  if (!job.stockholm_match) {
    return false;
  }

  if (!job.finance_match) {
    return false;
  }

  return Number(job.relevance_score || 0) >= minScore;
}
