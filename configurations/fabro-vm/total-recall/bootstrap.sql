CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;

SELECT format('ALTER DATABASE %I OWNER TO memory_migration', d.datname)
FROM pg_database AS d
JOIN pg_roles AS r ON r.rolname = 'memory_migration'
WHERE d.datname = 'memory'
  AND d.datdba <> r.oid
\gexec

SELECT format('ALTER SCHEMA %I OWNER TO memory_migration', n.nspname)
FROM pg_namespace AS n
JOIN pg_roles AS r ON r.rolname = 'memory_migration'
WHERE n.nspname = 'public'
  AND n.nspowner <> r.oid
\gexec
