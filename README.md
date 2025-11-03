## First Steps

1. Default settings pass is "wadboard". Change it in backend/server.js:
   ```bash 
   // -----------------------
   // Admin password (change this)
   // -----------------------
   const ADMIN_PASSWORD = "wadboard";
   ```


2. Go to backend/ and execute:
   ```bash
   setsid node server.js # or setsid node server.js >> /path/to/log_file.log
   ```
