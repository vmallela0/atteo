-- When each person last opened each board (the web page or the app), for the tabs' "Last opened" order (vedu #5192).
ALTER TABLE members ADD COLUMN opened_at INTEGER;
