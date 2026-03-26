import { truncate } from "./utils.js";

function renderJobLine(job) {
  const bits = [
    `**${job.company}**`,
    job.title,
    job.location ? `(${job.location})` : null,
    `score ${job.relevance_score}`
  ].filter(Boolean);

  const reason = job.why_relevant ? ` - ${truncate(job.why_relevant, 120)}` : "";
  return `• ${bits.join(" ")}${reason}\n${job.apply_url}`;
}

function chunkMessages(lines, limit = 1800) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n\n${line}` : line;
    if (candidate.length > limit) {
      if (current) {
        chunks.push(current);
      }
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export async function sendDiscordNotification({
  webhookUrl,
  jobs,
  timestamp,
  dryRun
}) {
  if (!jobs.length) {
    return;
  }

  if (dryRun) {
    return;
  }

  if (!webhookUrl) {
    throw new Error("Missing DISCORD_WEBHOOK_URL.");
  }

  const header = `New Stockholm finance jobs found on ${timestamp.slice(0, 10)}: ${jobs.length}`;
  const lines = [header, ...jobs.map((job) => renderJobLine(job))];
  const chunks = chunkMessages(lines);

  for (const content of chunks) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} ${body}`);
    }
  }
}
