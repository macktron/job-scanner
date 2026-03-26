import { COMPANIES } from "./config/companies.js";
import { fetchCareerSnapshots } from "./lib/http.js";
import { discoverDirectJobs } from "./lib/direct-adapters.js";
import { discoverExternalJobs, discoverJobsForCompany } from "./lib/openai.js";
import { enrichJob, isRelevantJob } from "./lib/relevance.js";
import { sendDiscordNotification } from "./lib/discord.js";
import {
  cleanupRunSnapshots,
  loadState,
  markJobsNotified,
  mergeState,
  saveRunSnapshot,
  saveState
} from "./lib/state.js";
import {
  buildJobFingerprint,
  normalizeUrl,
  nowIso,
  uniqueBy
} from "./lib/utils.js";

const MIN_RELEVANCE_SCORE = Number(process.env.MIN_RELEVANCE_SCORE || 55);
const MAX_JOBS_PER_COMPANY = Number(process.env.MAX_JOBS_PER_COMPANY || 8);
const MISSING_RUNS_THRESHOLD = Number(process.env.MISSING_RUNS_THRESHOLD || 3);
const RUN_RETENTION_DAYS = Number(process.env.RUN_RETENTION_DAYS || 45);
const RUN_RETENTION_COUNT = Number(process.env.RUN_RETENTION_COUNT || 60);
const ENABLE_OPENAI_FALLBACK = String(process.env.ENABLE_OPENAI_FALLBACK || "true").toLowerCase() !== "false";
const ENABLE_GLOBAL_DISCOVERY = String(process.env.ENABLE_GLOBAL_DISCOVERY || "true").toLowerCase() !== "false";
const MAX_EXTERNAL_JOBS = Number(process.env.MAX_EXTERNAL_JOBS || 12);
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

function finalizeJob(job, company, timestamp) {
  const normalized = {
    ...job,
    company: company.name,
    company_id: company.id,
    source_url: normalizeUrl(job.source_url || company.careerUrls[0]),
    apply_url: normalizeUrl(job.apply_url || job.source_url || company.careerUrls[0]),
    discovered_at: timestamp
  };

  return {
    ...normalized,
    id: `${company.id}_${buildJobFingerprint(normalized)}`
  };
}

async function scanCompany(company, timestamp) {
  let jobs = [];
  let usedFallback = false;
  let directError = null;

  if (company.adapter) {
    try {
      jobs = await discoverDirectJobs(company);
    } catch (error) {
      directError = error;
    }
  }

  if ((!jobs.length || !company.adapter) && ENABLE_OPENAI_FALLBACK && process.env.OPENAI_API_KEY) {
    const snapshots = await fetchCareerSnapshots(company);
    jobs = await discoverJobsForCompany({
      company,
      snapshots,
      maxJobsPerCompany: MAX_JOBS_PER_COMPANY
    });
    usedFallback = true;
  }

  if (!jobs.length && directError && !usedFallback) {
    throw directError;
  }

  return jobs
    .map((job) => ({
      ...job,
      discovery_method: job.discovery_method || (usedFallback ? "openai:web_search" : "direct:generic")
    }))
    .map((job) => enrichJob(finalizeJob(job, company, timestamp), company, MIN_RELEVANCE_SCORE))
    .filter((job) => isRelevantJob(job, MIN_RELEVANCE_SCORE));
}

function buildExternalCompany(job) {
  return {
    id: job.company_id || `external_${buildJobFingerprint(job)}`,
    name: job.company,
    priority: "medium",
    stockholmSignals: ["stockholm"]
  };
}

async function scanExternalMarket(timestamp) {
  if (!ENABLE_GLOBAL_DISCOVERY || !process.env.OPENAI_API_KEY) {
    return [];
  }

  const externalJobs = await discoverExternalJobs({
    excludedCompanyNames: COMPANIES.map((company) => company.name),
    maxJobs: MAX_EXTERNAL_JOBS
  });

  return externalJobs
    .map((job) => {
      const company = buildExternalCompany(job);
      return enrichJob(finalizeJob(job, company, timestamp), company, MIN_RELEVANCE_SCORE);
    })
    .filter((job) => isRelevantJob(job, MIN_RELEVANCE_SCORE));
}

async function main() {
  const timestamp = nowIso();
  const runStamp = timestamp.replace(/[:.]/g, "-");
  const { activeState, seenState } = await loadState();
  const discoveredJobs = [];
  const errors = [];

  for (const company of COMPANIES) {
    try {
      const companyJobs = await scanCompany(company, timestamp);
      discoveredJobs.push(...companyJobs);
      console.log(`${company.name}: ${companyJobs.length} relevant jobs`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ company: company.name, error: message });
      console.error(`${company.name}: ${message}`);
    }
  }

  try {
    const externalJobs = await scanExternalMarket(timestamp);
    discoveredJobs.push(...externalJobs);
    console.log(`External market scan: ${externalJobs.length} relevant jobs`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ company: "External market scan", error: message });
    console.error(`External market scan: ${message}`);
  }

  const dedupedJobs = uniqueBy(discoveredJobs, (job) => job.id).sort((left, right) => {
    if (right.relevance_score !== left.relevance_score) {
      return right.relevance_score - left.relevance_score;
    }
    return left.company.localeCompare(right.company);
  });

  let nextState = mergeState({
    timestamp,
    discoveredJobs: dedupedJobs,
    activeState,
    seenState,
    missingRunsThreshold: MISSING_RUNS_THRESHOLD
  });

  const jobsToNotify = nextState.newJobs.filter((job) => !job.notified_at);
  await sendDiscordNotification({
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    jobs: jobsToNotify,
    timestamp,
    dryRun: DRY_RUN
  });

  if (jobsToNotify.length && !DRY_RUN) {
    nextState = {
      ...nextState,
      ...markJobsNotified({
        activeState: nextState.activeState,
        seenState: nextState.seenState,
        jobs: jobsToNotify,
        timestamp
      })
    };
  }

  const snapshot = {
    timestamp,
    dry_run: DRY_RUN,
    min_relevance_score: MIN_RELEVANCE_SCORE,
    missing_runs_threshold: MISSING_RUNS_THRESHOLD,
    company_count: COMPANIES.length,
    discovered_jobs: dedupedJobs,
    new_jobs: jobsToNotify,
    errors
  };

  await saveState({
    activeState: nextState.activeState,
    seenState: nextState.seenState
  });
  await saveRunSnapshot(runStamp, snapshot);
  const deletedRunSnapshots = await cleanupRunSnapshots({
    retentionDays: RUN_RETENTION_DAYS,
    retentionCount: RUN_RETENTION_COUNT
  });

  console.log(
    JSON.stringify(
      {
        discovered: dedupedJobs.length,
        new_jobs: jobsToNotify.length,
        active_jobs: nextState.activeState.jobs.length,
        errors: errors.length,
        deleted_run_snapshots: deletedRunSnapshots.length,
        dry_run: DRY_RUN
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
