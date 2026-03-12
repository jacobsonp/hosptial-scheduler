'use strict';

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new DatabaseSync(path.join(DATA_DIR, 'vetscheduler.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('corporate','location','staff')),
    location_id   INTEGER REFERENCES locations(id),
    person_id     INTEGER,
    person_type   TEXT CHECK(person_type IN ('dvm','staff') OR person_type IS NULL)
  );

  CREATE TABLE IF NOT EXISTS dvms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    specialty   TEXT DEFAULT 'General Practice',
    color       TEXT DEFAULT '#3B82F6'
  );

  CREATE TABLE IF NOT EXISTS support_staff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    role_title  TEXT DEFAULT 'Support Staff',
    color       TEXT DEFAULT '#16A34A'
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    person_id   INTEGER NOT NULL,
    person_type TEXT NOT NULL CHECK(person_type IN ('dvm','staff')),
    hours       REAL DEFAULT 8,
    UNIQUE(location_id, date, person_id, person_type)
  );

  CREATE TABLE IF NOT EXISTS visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    patient     TEXT NOT NULL,
    type        TEXT NOT NULL,
    duration    REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS time_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id    INTEGER NOT NULL,
    person_type  TEXT NOT NULL CHECK(person_type IN ('dvm','staff')),
    date         TEXT NOT NULL,
    hours_worked REAL,
    break_hours  REAL DEFAULT 0,
    is_time_off  INTEGER DEFAULT 0,
    notes        TEXT,
    UNIQUE(person_id, person_type, date)
  );

  CREATE TABLE IF NOT EXISTS location_settings (
    location_id          INTEGER PRIMARY KEY REFERENCES locations(id),
    visits_per_dvm_hour  REAL DEFAULT 2.5,
    support_per_dvm_hour REAL DEFAULT 1.5
  );

  CREATE TABLE IF NOT EXISTS visit_counts (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (location_id, date)
  );
`);

// Safe migrations for existing databases
const tryExec = sql => { try { db.exec(sql); } catch (_) {} };
tryExec('ALTER TABLE assignments ADD COLUMN break_hours REAL DEFAULT 0');
tryExec('ALTER TABLE assignments ADD COLUMN time_off_hours REAL DEFAULT 0');

function seed() {
  const count = db.prepare('SELECT COUNT(*) as c FROM locations').get().c;
  if (count > 0) return;

  const DVM_PALETTE   = ['#3B82F6','#7C3AED','#DB2777','#F59E0B','#0D9488','#EF4444'];
  const STAFF_PALETTE = ['#16A34A','#0891B2','#7C3AED','#D97706','#BE123C','#0369A1'];

  const insertLoc  = db.prepare('INSERT INTO locations (name) VALUES (?)');
  const insertSet  = db.prepare('INSERT INTO location_settings (location_id) VALUES (?)');
  const insertDvm  = db.prepare('INSERT INTO dvms (location_id, name, specialty, color) VALUES (?,?,?,?)');
  const insertStaf = db.prepare('INSERT INTO support_staff (location_id, name, role_title, color) VALUES (?,?,?,?)');
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, location_id, person_id, person_type) VALUES (?,?,?,?,?,?)'
  );

  const pw     = bcrypt.hashSync('password123', 10);
  const corpPw = bcrypt.hashSync('corporate123', 10);

  insertUser.run('corporate', corpPw, 'corporate', null, null, null);

  const locations = [
    { name: 'Downtown Clinic',          slug: 'downtown'   },
    { name: 'Westside Animal Hospital', slug: 'westside'   },
    { name: 'North Shore Vet Center',   slug: 'northshore' },
  ];

  const dvmData = [
    [{ n:'Dr. Smith',    s:'General Practice'  }, { n:'Dr. Johnson',  s:'Surgery'           }, { n:'Dr. Williams', s:'Internal Medicine'}],
    [{ n:'Dr. Lee',      s:'Exotic Animals'    }, { n:'Dr. Chen',     s:'General Practice'  }, { n:'Dr. Patel',    s:'Dentistry'         }],
    [{ n:'Dr. Garcia',   s:'Emergency'         }, { n:'Dr. Kim',      s:'Oncology'          }, { n:'Dr. Brown',    s:'General Practice'  }],
  ];

  const staffData = [
    [{ n:'Alice Chen',    r:'Vet Tech'      }, { n:'Bob Martinez', r:'Vet Tech'      }, { n:'Carol Davis',  r:'Receptionist'   }],
    [{ n:'Dan Wilson',    r:'Vet Assistant' }, { n:'Eva Park',     r:'Vet Tech'      }, { n:'Frank Liu',    r:'Receptionist'   }],
    [{ n:'Grace Taylor',  r:'Vet Tech'      }, { n:'Henry Nguyen', r:'Vet Assistant' }, { n:'Iris Cohen',   r:'Receptionist'   }],
  ];

  locations.forEach(({ name, slug }, i) => {
    const locId = insertLoc.run(name).lastInsertRowid;
    insertSet.run(locId);
    insertUser.run(slug, pw, 'location', locId, null, null);

    dvmData[i].forEach(({ n, s }, j) => {
      const dvmId = insertDvm.run(locId, n, s, DVM_PALETTE[j]).lastInsertRowid;
      if (j === 0) {
        const uname = n.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10) + i;
        try { insertUser.run(uname, pw, 'staff', locId, dvmId, 'dvm'); } catch (_) {}
      }
    });

    staffData[i].forEach(({ n, r }, j) => {
      const sid = insertStaf.run(locId, n, r, STAFF_PALETTE[j]).lastInsertRowid;
      if (j === 0) {
        const uname = n.split(' ')[0].toLowerCase() + i;
        try { insertUser.run(uname, pw, 'staff', locId, sid, 'staff'); } catch (_) {}
      }
    });
  });

  console.log('Database seeded. Demo accounts:');
  console.log('  corporate / corporate123  (corporate rollup)');
  console.log('  downtown  / password123   (Downtown Clinic scheduler)');
  console.log('  westside  / password123   (Westside Animal Hospital scheduler)');
  console.log('  northshore/ password123   (North Shore Vet Center scheduler)');
}

seed();

module.exports = db;
