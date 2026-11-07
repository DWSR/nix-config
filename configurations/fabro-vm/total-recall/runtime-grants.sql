GRANT SELECT, INSERT ON TABLE memories TO memory_application;
GRANT SELECT, INSERT ON TABLE memory_embeddings TO memory_application;
GRANT SELECT ON TABLE session_events TO memory_application;
GRANT SELECT ON TABLE raw_observations TO memory_application;
GRANT SELECT, INSERT, UPDATE ON TABLE session_records TO memory_application;
GRANT SELECT, INSERT, UPDATE ON TABLE session_processing_attempts TO memory_application;
GRANT SELECT, INSERT, UPDATE ON TABLE session_memory_candidates TO memory_application;
