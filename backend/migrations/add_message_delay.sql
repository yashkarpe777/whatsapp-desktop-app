-- Migration: Add message_delay_seconds column to campaigns table
-- This allows users to configure custom delay between messages to prevent WhatsApp blocks

-- Add column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'campaigns' 
        AND column_name = 'message_delay_seconds'
    ) THEN
        ALTER TABLE campaigns 
        ADD COLUMN message_delay_seconds INTEGER DEFAULT 2 
        CHECK (message_delay_seconds >= 1 AND message_delay_seconds <= 60);
        
        RAISE NOTICE 'Added message_delay_seconds column to campaigns table';
    ELSE
        RAISE NOTICE 'message_delay_seconds column already exists';
    END IF;
END $$;

-- Update existing campaigns to have default delay of 2 seconds
UPDATE campaigns 
SET message_delay_seconds = 2 
WHERE message_delay_seconds IS NULL;

COMMENT ON COLUMN campaigns.message_delay_seconds IS 'Delay in seconds between sending messages (1-60 seconds, default 2)';
