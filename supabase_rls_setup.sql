-- ==========================================
-- NAVADRISHTI RLS POLICIES (BETA 1.0)
-- ==========================================

-- 1. Enable RLS on core tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE csr_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE csr_project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- 2. Define User Role Helpers
-- Note: Assumes 'users' table has 'auth_id' linked to auth.users.id
CREATE OR REPLACE FUNCTION get_current_user_type() RETURNS text AS $$
  SELECT user_type FROM users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_current_user_ngo_id() RETURNS int AS $$
  SELECT id FROM users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE;

-- 3. USERS Table Policies
CREATE POLICY "Users can view their own profile"
  ON users FOR SELECT
  USING (auth_id = auth.uid());

CREATE POLICY "CAs can view all profiles for audit"
  ON users FOR SELECT
  USING (get_current_user_type() = 'ca');

-- 4. CSR_PROJECTS Table Policies
CREATE POLICY "NGOs can only view their assigned projects"
  ON csr_projects FOR SELECT
  USING (ngo_user_id = get_current_user_ngo_id());

CREATE POLICY "CAs can view all projects"
  ON csr_projects FOR SELECT
  USING (get_current_user_type() = 'ca');

-- 5. CSR_PROJECT_MILESTONES Table Policies
CREATE POLICY "NGOs can view/update their own milestones"
  ON csr_project_milestones FOR ALL
  USING (ngo_user_id = get_current_user_ngo_id());

CREATE POLICY "CAs can view all milestones"
  ON csr_project_milestones FOR SELECT
  USING (get_current_user_type() = 'ca');

-- 6. EVENTS Table Policies (The Audit Ledger)
CREATE POLICY "NGOs can only view their own project events"
  ON events FOR SELECT
  USING (ngo_id = get_current_user_ngo_id());

CREATE POLICY "NGOs can insert events for their own projects"
  ON events FOR INSERT
  WITH CHECK (ngo_id = get_current_user_ngo_id());

CREATE POLICY "CAs can view all events"
  ON events FOR SELECT
  USING (get_current_user_type() = 'ca');

-- ==========================================
-- END OF MIGRATION
-- ==========================================
