# job-scanner

Daglig GitHub Actions-baserad scanner som letar efter nya finansjobb i Stockholm, använder OpenAI för att hitta och strukturera relevanta roller, sparar alla upptäckta jobb i JSON och skickar bara nya träffar till Discord.

## Hur det fungerar

- Workflowet kan köras manuellt och är schemalagt för att landa på 18:00 Stockholmstid varje dag.
- För varje bolag hämtas officiella karriärsidor som kontext.
- För prioriterade bolag används direkta adapters mot deras officiella karriärsidor först. OpenAI används bara som fallback när direkt discovery inte räcker.
- Utöver den fasta bolagslistan görs också en generell marknadssökning efter nya Stockholm-/finansroller hos andra relevanta arbetsgivare.
- Relevansen viktas mot en personlig profil med extra tyngd på quant, trading, risk, treasury och data science.
- Resultatet dedupliceras mot `data/jobs/seen.json` så att redan hittade jobb inte notifieras igen.
- Aktiva jobb hålls i `data/jobs/active.json` och en körningssnapshot sparas i `data/runs/`.
- Nya jobb skickas till Discord via webhook.

## Filer att känna till

- `src/config/companies.js`: bolag och karriär-URL:er
- `src/config/universe.js`: områden och nyckelord
- `src/config/profile.js`: personlig viktning för relevans
- `src/index.js`: huvudflödet
- `data/jobs/active.json`: nu aktiva relevanta jobb
- `data/jobs/seen.json`: alla jobb som redan setts

## Secrets och variabler

Lägg in dessa i GitHub-repot innan workflowet körs:

- `OPENAI_API_KEY`: krävs
- `DISCORD_WEBHOOK_URL`: krävs för notifieringar

Valfria GitHub Actions variables:

- `OPENAI_MODEL`: standard är `gpt-5-mini`
- `MIN_RELEVANCE_SCORE`: standard är `65`
- `MAX_JOBS_PER_COMPANY`: standard är `8`
- `MISSING_RUNS_THRESHOLD`: standard är `3`
- `RUN_RETENTION_DAYS`: standard är `45`
- `RUN_RETENTION_COUNT`: standard är `60`
- `ENABLE_OPENAI_FALLBACK`: standard är `true`
- `ENABLE_GLOBAL_DISCOVERY`: standard är `true`
- `MAX_EXTERNAL_JOBS`: standard är `12`

## Manuell körning

Kör workflowet via `workflow_dispatch`. Sätt `dry_run=true` om du vill uppdatera state utan att skicka Discord-meddelanden.

## Tidsschema

GitHub Actions använder UTC för `schedule`. Därför triggas workflowet två gånger per dag, men en liten gate i workflowet släpper bara igenom den körning som faktiskt motsvarar 18:00 i `Europe/Stockholm`. På så sätt fungerar det även när Sverige växlar mellan CET och CEST.
