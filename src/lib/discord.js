import { truncate } from "./utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderJobLine(job) {
  const bits = [
    `**${job.title}**`,
    job.company,
    job.location ? `(${truncate(job.location, 28)})` : null
  ].filter(Boolean);

  return `• ${bits.join(" - ")}\n${job.apply_url}`;
}

function chunkMessages(lines, limit = 1850) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
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

  const header = `New Stockholm junior finance jobs (${jobs.length}) - ${timestamp.slice(0, 10)}`;
  const lines = [header, ...jobs.map((job) => renderJobLine(job))];
  const chunks = chunkMessages(lines);

  for (const content of chunks) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(20_000)
      });

      if (response.ok) {
        break;
      }

      if (response.status === 429 && attempt < 3) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = Number(retryAfterHeader || 1);
        await sleep(Math.max(retryAfterSeconds, 1) * 1000);
        continue;
      }

      const body = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} ${body}`);
    }
  }
}
