-- Migration: Add phone column to campaign_logs table
-- This is required for campaign creation to work properly

DO $$ 
BEGIN
    -- Add phone column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaign_logs' 
        AND column_name = 'phone'
    ) THEN
        ALTER TABLE campaign_logs 
        ADD COLUMN phone VARCHAR(20);
        
        -- Update existing rows with phone from contacts table
        UPDATE campaign_logs cl
        SET phone = c.phone
        FROM contacts c
        WHERE cl.contact_id = c.id AND cl.phone IS NULL;
        
        -- Set default empty string for any remaining NULL values
        UPDATE campaign_logs SET phone = '' WHERE phone IS NULL;
        
        -- Make phone NOT NULL after populating data
        ALTER TABLE campaign_logs ALTER COLUMN phone SET NOT NULL;
        
        RAISE NOTICE 'Added phone column to campaign_logs table';
    ELSE
        RAISE NOTICE 'phone column already exists in campaign_logs';
    END IF;
END $$;

-- Add comment
COMMENT ON COLUMN campaign_logs.phone IS 'Contact phone number for this campaign log entry';
