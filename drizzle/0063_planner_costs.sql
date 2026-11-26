-- The data and its indexes sit in memory or on SSD, where a random read costs little more than a sequential one.
-- At the default (4, for spinning disks) the planner read every paper's search vector rather than use the GIN
-- index for a common word: "transformer" took a second and a half to count, 45 ms through the index. Set on the
-- database, so it holds for every new connection, whatever its name in this environment.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET random_page_cost = 1.1', current_database());
  EXECUTE format('ALTER DATABASE %I SET effective_io_concurrency = 200', current_database());
END $$;
