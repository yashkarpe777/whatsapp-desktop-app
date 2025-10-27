-- Migration: Remove foreign key constraints to users table
-- Local DB should not have FK to users since users are in Render DB

DO $$ 
BEGIN
    -- Drop FK constraint from contact_groups
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'contact_groups_user_id_fkey'
        AND table_name = 'contact_groups'
    ) THEN
        ALTER TABLE contact_groups DROP CONSTRAINT contact_groups_user_id_fkey;
        RAISE NOTICE 'Dropped FK constraint: contact_groups_user_id_fkey';
    ELSE
        RAISE NOTICE 'FK constraint contact_groups_user_id_fkey does not exist';
    END IF;

    -- Drop FK constraint from contacts
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'contacts_user_id_fkey'
        AND table_name = 'contacts'
    ) THEN
        ALTER TABLE contacts DROP CONSTRAINT contacts_user_id_fkey;
        RAISE NOTICE 'Dropped FK constraint: contacts_user_id_fkey';
    ELSE
        RAISE NOTICE 'FK constraint contacts_user_id_fkey does not exist';
    END IF;

    -- Drop FK constraint from campaigns
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'campaigns_user_id_fkey'
        AND table_name = 'campaigns'
    ) THEN
        ALTER TABLE campaigns DROP CONSTRAINT campaigns_user_id_fkey;
        RAISE NOTICE 'Dropped FK constraint: campaigns_user_id_fkey';
    ELSE
        RAISE NOTICE 'FK constraint campaigns_user_id_fkey does not exist';
    END IF;

    -- Drop FK constraint from uploads
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uploads_user_id_fkey'
        AND table_name = 'uploads'
    ) THEN
        ALTER TABLE uploads DROP CONSTRAINT uploads_user_id_fkey;
        RAISE NOTICE 'Dropped FK constraint: uploads_user_id_fkey';
    ELSE
        RAISE NOTICE 'FK constraint uploads_user_id_fkey does not exist';
    END IF;

    -- Drop FK constraint from settings
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'settings_updated_by_fkey'
        AND table_name = 'settings'
    ) THEN
        ALTER TABLE settings DROP CONSTRAINT settings_updated_by_fkey;
        RAISE NOTICE 'Dropped FK constraint: settings_updated_by_fkey';
    ELSE
        RAISE NOTICE 'FK constraint settings_updated_by_fkey does not exist';
    END IF;

END $$;

-- Verify constraints are removed
SELECT 
    tc.table_name, 
    tc.constraint_name, 
    tc.constraint_type
FROM information_schema.table_constraints tc
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('contact_groups', 'contacts', 'campaigns', 'uploads', 'settings')
  AND tc.constraint_name LIKE '%user_id%';
