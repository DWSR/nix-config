-- LiteLLM proxy views.
--
-- Transcribed from the pinned LiteLLM 1.86.0
-- `litellm/proxy/db/create_views.py` so the schema-initialization unit can
-- create all eight views as the database's migration role before the proxy
-- starts. The proxy's own startup path would otherwise try to create them as
-- the application role, which holds no DDL privilege.
--
-- `CREATE OR REPLACE VIEW` keeps the file safe to apply on every switch: the
-- view definitions are refreshed in place and no existing object is dropped.
-- This file is pure view SQL; ownership and grants are applied by the
-- `fabro.postgres` provisioning units.

CREATE OR REPLACE VIEW "LiteLLM_VerificationTokenView" AS
SELECT
    v.*,
    t.spend AS team_spend,
    t.max_budget AS team_max_budget,
    t.tpm_limit AS team_tpm_limit,
    t.rpm_limit AS team_rpm_limit,
    p.project_alias AS project_alias
FROM "LiteLLM_VerificationToken" v
LEFT JOIN "LiteLLM_TeamTable" t ON v.team_id = t.team_id
LEFT JOIN "LiteLLM_ProjectTable" p ON v.project_id = p.project_id;

CREATE OR REPLACE VIEW "MonthlyGlobalSpend" AS
SELECT
    DATE("startTime") AS date,
    SUM("spend") AS spend
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
GROUP BY DATE("startTime");

CREATE OR REPLACE VIEW "Last30dKeysBySpend" AS
SELECT
    L."api_key",
    V."key_alias",
    V."key_name",
    SUM(L."spend") AS total_spend
FROM "LiteLLM_SpendLogs" L
LEFT JOIN "LiteLLM_VerificationToken" V ON L."api_key" = V."token"
WHERE L."startTime" >= (CURRENT_DATE - INTERVAL '30 days')
GROUP BY L."api_key", V."key_alias", V."key_name"
ORDER BY total_spend DESC;

CREATE OR REPLACE VIEW "Last30dModelsBySpend" AS
SELECT
    "model",
    SUM("spend") AS total_spend
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
    AND "model" != ''
GROUP BY "model"
ORDER BY total_spend DESC;

CREATE OR REPLACE VIEW "MonthlyGlobalSpendPerKey" AS
SELECT
    DATE("startTime") AS date,
    SUM("spend") AS spend,
    api_key AS api_key
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
GROUP BY DATE("startTime"), api_key;

CREATE OR REPLACE VIEW "MonthlyGlobalSpendPerUserPerKey" AS
SELECT
    DATE("startTime") AS date,
    SUM("spend") AS spend,
    api_key AS api_key,
    "user" AS "user"
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
GROUP BY DATE("startTime"), "user", api_key;

CREATE OR REPLACE VIEW "DailyTagSpend" AS
SELECT
    jsonb_array_elements_text(request_tags) AS individual_request_tag,
    DATE(s."startTime") AS spend_date,
    COUNT(*) AS log_count,
    SUM(spend) AS total_spend
FROM "LiteLLM_SpendLogs" s
GROUP BY individual_request_tag, DATE(s."startTime");

CREATE OR REPLACE VIEW "Last30dTopEndUsersSpend" AS
SELECT
    end_user,
    COUNT(*) AS total_events,
    SUM(spend) AS total_spend
FROM "LiteLLM_SpendLogs"
WHERE end_user <> ''
    AND end_user <> user
    AND "startTime" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY end_user
ORDER BY total_spend DESC
LIMIT 100;
