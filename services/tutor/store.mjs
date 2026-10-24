import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export function openStore(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(dir,'tutor.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT OR IGNORE INTO settings VALUES('stopped','0');
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,idem TEXT NOT NULL,input TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,reserve INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,media_token TEXT NOT NULL,UNIQUE(owner,idem));
 CREATE INDEX IF NOT EXISTS task_owner ON tasks(owner,created);
 CREATE INDEX IF NOT EXISTS task_status ON tasks(status,created);
 CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY,jobs INTEGER NOT NULL,calls INTEGER NOT NULL,cost INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS owner_daily(owner TEXT NOT NULL,day TEXT NOT NULL,jobs INTEGER NOT NULL,PRIMARY KEY(owner,day));
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,created INTEGER NOT NULL,expires INTEGER NOT NULL);
 UPDATE tasks SET status='failed',stage='failed',error='INTERRUPTED' WHERE status='running';`);
 return db;
}
