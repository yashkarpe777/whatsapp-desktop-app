
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR,
    email VARCHAR,
    phone VARCHAR,
    password_hash VARCHAR,
    role VARCHAR,
    coins INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE contact_groups (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR,
    description TEXT,
    total_contacts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES contact_groups(id) ON DELETE SET NULL,
    name VARCHAR,
    phone VARCHAR,
    email VARCHAR,
    additional_data JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE campaigns (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR,
    message TEXT,
    media_url VARCHAR,
    contact_group_id INTEGER REFERENCES contact_groups(id) ON DELETE SET NULL,
    status VARCHAR,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    message_delay_seconds INTEGER DEFAULT 0,
    coins_spent INTEGER DEFAULT 0,
    whatsapp_session_id VARCHAR
);

CREATE TABLE campaign_logs (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    status VARCHAR,
    error_message TEXT,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    phone VARCHAR,
    message TEXT,
    media_url VARCHAR
);

CREATE TABLE campaign_state (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    state JSONB,
    updated_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE coin_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER,
    type VARCHAR,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE settings (
    id SERIAL PRIMARY KEY,
    key VARCHAR,
    value TEXT,
    description TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE otp_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    otp VARCHAR,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE uploads (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES contact_groups(id) ON DELETE SET NULL,
    originalname VARCHAR,
    stored_filename VARCHAR,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE whatsapp_sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR,
    phone_number VARCHAR,
    push_name VARCHAR,
    is_active BOOLEAN DEFAULT TRUE,
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE cleanup_logs (
    id SERIAL PRIMARY KEY,
    operation VARCHAR,
    table_name VARCHAR,
    records_deleted INTEGER,
    cleanup_date TIMESTAMP DEFAULT NOW(),
    details TEXT
);
