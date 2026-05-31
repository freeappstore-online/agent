-- Backfill app ownership for agent-deployed apps.
--
-- Before this fix, the agent created repos + D1 routes but never recorded
-- who owns each app in the `apps` table. This means /v1/apps/mine returns
-- nothing for agent-created apps, and the console "My Apps" list is wrong.
--
-- Run with: npx wrangler d1 execute fas --remote --file scripts/backfill-app-ownership.sql
-- (from the fas/agent or fas/platform directory)

INSERT OR IGNORE INTO apps (id, owner_login, created_at, store)
SELECT s.app_id, u.github_login, s.created_at, 'apps'
FROM agent_sessions s
JOIN users u ON u.id = s.user_id
WHERE s.app_id IS NOT NULL
  AND s.deployed = 1
  AND s.app_id NOT IN (SELECT id FROM apps);
