const eventName = process.env.GITHUB_EVENT_NAME || "";
const timezone = process.env.SCHEDULE_TIMEZONE || "Europe/Stockholm";
const targetHour = Number(process.env.SCHEDULE_TARGET_HOUR || 18);

if (eventName !== "schedule") {
  console.log("should_run=true");
  process.exit(0);
}

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: timezone,
  hour: "2-digit",
  hour12: false
});

const stockholmHour = Number(formatter.format(new Date()));
const shouldRun = stockholmHour === targetHour;

console.log(`timezone=${timezone}`);
console.log(`stockholm_hour=${stockholmHour}`);
console.log(`target_hour=${targetHour}`);
console.log(`should_run=${shouldRun}`);
