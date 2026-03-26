import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { readJson, writeJson } from "./utils.js";

const ROOT = process.cwd();
const ACTIVE_PATH = path.join(ROOT, "data", "jobs", "active.json");
const SEEN_PATH = path.join(ROOT, "data", "jobs", "seen.json");
const RUNS_DIR = path.join(ROOT, "data", "runs");

const DEFAULT_ACTIVE = {
  updated_at: null,
  jobs: []
};

const DEFAULT_SEEN = {
  updated_at: null,
  jobs: {}
};

export async function loadState() {
  const [activeState, seenState] = await Promise.all([
    readJson(ACTIVE_PATH, DEFAULT_ACTIVE),
    readJson(SEEN_PATH, DEFAULT_SEEN)
  ]);

  return {
    activeState,
    seenState
  };
}

export function mergeState({
  timestamp,
  discoveredJobs,
  activeState,
  seenState,
  missingRunsThreshold
}) {
  const previousActiveById = new Map(
    (activeState.jobs || []).map((job) => [job.id, job])
  );
  const nextSeenJobs = { ...(seenState.jobs || {}) };
  const currentById = new Map(discoveredJobs.map((job) => [job.id, job]));
  const nextActiveJobs = [];
  const newJobs = [];

  for (const job of discoveredJobs) {
    const previous = previousActiveById.get(job.id);
    const seenEntry = nextSeenJobs[job.id];
    const merged = {
      ...(previous || {}),
      ...job,
      status: "active",
      missing_runs: 0,
      first_seen_at: previous?.first_seen_at || seenEntry?.first_seen_at || timestamp,
      last_seen_at: timestamp,
      notified_at: previous?.notified_at || seenEntry?.notified_at || null
    };

    nextActiveJobs.push(merged);
    nextSeenJobs[job.id] = {
      id: job.id,
      company: job.company,
      title: job.title,
      apply_url: job.apply_url,
      first_seen_at: merged.first_seen_at,
      last_seen_at: timestamp,
      last_status: "active",
      notified_at: merged.notified_at
    };

    if (!seenEntry) {
      newJobs.push(merged);
    }
  }

  for (const previous of activeState.jobs || []) {
    if (currentById.has(previous.id)) {
      continue;
    }

    const carried = {
      ...previous,
      missing_runs: Number(previous.missing_runs || 0) + 1
    };

    if (carried.missing_runs < missingRunsThreshold) {
      nextActiveJobs.push(carried);
      continue;
    }

    if (nextSeenJobs[previous.id]) {
      nextSeenJobs[previous.id] = {
        ...nextSeenJobs[previous.id],
        last_status: "stale"
      };
    }
  }

  nextActiveJobs.sort((left, right) => {
    if (right.relevance_score !== left.relevance_score) {
      return right.relevance_score - left.relevance_score;
    }
    return left.company.localeCompare(right.company);
  });

  return {
    activeState: {
      updated_at: timestamp,
      jobs: nextActiveJobs
    },
    seenState: {
      updated_at: timestamp,
      jobs: nextSeenJobs
    },
    newJobs
  };
}

export function markJobsNotified({ activeState, seenState, jobs, timestamp }) {
  const notifiedIds = new Set(jobs.map((job) => job.id));
  const nextActive = {
    ...activeState,
    jobs: (activeState.jobs || []).map((job) => {
      if (!notifiedIds.has(job.id)) {
        return job;
      }
      return {
        ...job,
        notified_at: timestamp
      };
    })
  };

  const nextSeen = {
    ...seenState,
    jobs: Object.fromEntries(
      Object.entries(seenState.jobs || {}).map(([id, job]) => {
        if (!notifiedIds.has(id)) {
          return [id, job];
        }
        return [
          id,
          {
            ...job,
            notified_at: timestamp
          }
        ];
      })
    )
  };

  return {
    activeState: nextActive,
    seenState: nextSeen
  };
}

export async function saveState({ activeState, seenState }) {
  await Promise.all([
    writeJson(ACTIVE_PATH, activeState),
    writeJson(SEEN_PATH, seenState)
  ]);
}

export async function saveRunSnapshot(fileStamp, snapshot) {
  const filePath = path.join(RUNS_DIR, `${fileStamp}.json`);
  await writeJson(filePath, snapshot);
}

function parseRunTimestampFromName(name) {
  const match = name.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/
  );

  if (!match) {
    return Number.NaN;
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond)
  );
}

export async function cleanupRunSnapshots({ retentionDays, retentionCount, now = new Date() }) {
  const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(RUNS_DIR, entry.name);
      return {
        name: entry.name,
        filePath,
        timestamp: parseRunTimestampFromName(entry.name)
      };
    })
    .sort((left, right) => right.name.localeCompare(left.name));

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const keep = new Set(files.slice(0, retentionCount).map((file) => file.filePath));
  const deleted = [];

  for (const file of files) {
    const fileDate = Number.isFinite(file.timestamp) ? new Date(file.timestamp) : null;
    const isOld = fileDate ? fileDate < cutoff : false;
    if (!keep.has(file.filePath) && isOld) {
      await rm(file.filePath, { force: true });
      deleted.push(file.name);
    }
  }

  return deleted;
}
