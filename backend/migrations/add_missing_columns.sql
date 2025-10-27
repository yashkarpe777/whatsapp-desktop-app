-- Migration: Add missing columns to campaigns table
-- Adds title, contact_group_id, error_message, and coins_spent columns

DO $$ 
BEGIN
    -- Add title column (alias for name)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaigns' 
        AND column_name = 'title'
    ) THEN
        ALTER TABLE campaigns 
        ADD COLUMN title VARCHAR(255);
        
        -- Copy existing name values to title
        UPDATE campaigns SET title = name WHERE title IS NULL;
        
        -- Make title NOT NULL after copying data
        ALTER TABLE campaigns ALTER COLUMN title SET NOT NULL;
        
        RAISE NOTICE 'Added title column to campaigns table';
    ELSE
        RAISE NOTICE 'title column already exists';
    END IF;

    -- Add contact_group_id column (alias for group_id)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaigns' 
        AND column_name = 'contact_group_id'
    ) THEN
        ALTER TABLE campaigns 
        ADD COLUMN contact_group_id INTEGER REFERENCES contact_groups(id) ON DELETE CASCADE;
        
        -- Copy existing group_id values to contact_group_id
        UPDATE campaigns SET contact_group_id = group_id WHERE contact_group_id IS NULL;
        
        RAISE NOTICE 'Added contact_group_id column to campaigns table';
    ELSE
        RAISE NOTICE 'contact_group_id column already exists';
    END IF;

    -- Add error_message column for storing campaign stop/failure reasons
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaigns' 
        AND column_name = 'error_message'
    ) THEN
        ALTER TABLE campaigns 
        ADD COLUMN error_message TEXT;
        
        RAISE NOTICE 'Added error_message column to campaigns table';
    ELSE
        RAISE NOTICE 'error_message column already exists';
    END IF;

    -- Add coins_spent column for tracking actual coins used
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaigns' 
        AND column_name = 'coins_spent'
    ) THEN
        ALTER TABLE campaigns 
        ADD COLUMN coins_spent INTEGER DEFAULT 0;
        
        -- Copy coins_used to coins_spent if exists
        UPDATE campaigns SET coins_spent = COALESCE(coins_used, 0) WHERE coins_spent IS NULL OR coins_spent = 0;
        
        RAISE NOTICE 'Added coins_spent column to campaigns table';
    ELSE
        RAISE NOTICE 'coins_spent column already exists';
    END IF;
END $$;

-- Add comments
COMMENT ON COLUMN campaigns.title IS 'Campaign title (alias for name)';
COMMENT ON COLUMN campaigns.contact_group_id IS 'Contact group ID (alias for group_id)';
COMMENT ON COLUMN campaigns.error_message IS 'Error message when campaign stops or fails';
COMMENT ON COLUMN campaigns.coins_spent IS 'Actual number of coins spent on this campaign';
