'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const db      = require('./db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'vsp-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ── AUTH MIDDLEWARE ──────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function canAccessLocation(req, locId) {
  if (req.session.role === 'corporate') return true;
  return String(req.session.locationId) === String(locId);
}

// ── STATIC FILES ─────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// Root redirect based on role
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  if (req.session.role === 'corporate') return res.redirect('/corporate.html');
  if (req.session.role === 'staff')     return res.redirect('/staff.html');
  return res.redirect('/scheduler.html');
});

// ── AUTH ROUTES ───────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId     = user.id;
  req.session.role       = user.role;
  req.session.locationId = user.location_id;
  req.session.personId   = user.person_id;
  req.session.personType = user.person_type;
  req.session.username   = user.username;

  res.json({ role: user.role, locationId: user.location_id });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    id:         req.session.userId,
    role:       req.session.role,
    locationId: req.session.locationId,
    personId:   req.session.personId,
    personType: req.session.personType,
    username:   req.session.username,
  });
});

// ── LOCATIONS ─────────────────────────────────────────────

app.get('/api/locations', requireAuth, (req, res) => {
  const locations = db.prepare('SELECT * FROM locations ORDER BY name').all();
  res.json(locations);
});

// ── PEOPLE ────────────────────────────────────────────────

app.get('/api/locations/:locId/people', requireAuth, (req, res) => {
  const { locId } = req.params;
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  const dvms  = db.prepare('SELECT * FROM dvms WHERE location_id = ? ORDER BY name').all(locId);
  const staff = db.prepare('SELECT * FROM support_staff WHERE location_id = ? ORDER BY name').all(locId);
  res.json({ dvms, staff });
});

app.post('/api/locations/:locId/dvms', requireAuth, (req, res) => {
  const { locId } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  const { name, specialty, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id  = db.prepare('INSERT INTO dvms (location_id, name, specialty, color) VALUES (?,?,?,?)').run(locId, name.trim(), specialty || 'General Practice', color || '#3B82F6').lastInsertRowid;
  res.json(db.prepare('SELECT * FROM dvms WHERE id = ?').get(id));
});

app.delete('/api/locations/:locId/dvms/:id', requireAuth, (req, res) => {
  const { locId, id } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM dvms WHERE id = ? AND location_id = ?').run(id, locId);
  db.prepare('DELETE FROM assignments WHERE person_id = ? AND person_type = ? AND location_id = ?').run(id, 'dvm', locId);
  res.json({ ok: true });
});

app.post('/api/locations/:locId/staff', requireAuth, (req, res) => {
  const { locId } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  const { name, role_title, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = db.prepare('INSERT INTO support_staff (location_id, name, role_title, color) VALUES (?,?,?,?)').run(locId, name.trim(), role_title || 'Support Staff', color || '#16A34A').lastInsertRowid;
  res.json(db.prepare('SELECT * FROM support_staff WHERE id = ?').get(id));
});

app.delete('/api/locations/:locId/staff/:id', requireAuth, (req, res) => {
  const { locId, id } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM support_staff WHERE id = ? AND location_id = ?').run(id, locId);
  db.prepare('DELETE FROM assignments WHERE person_id = ? AND person_type = ? AND location_id = ?').run(id, 'staff', locId);
  res.json({ ok: true });
});

// ── SCHEDULE ──────────────────────────────────────────────

function weekDates(weekStart) {
  const dates = [];
  const start = new Date(weekStart + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

app.get('/api/locations/:locId/schedule', requireAuth, (req, res) => {
  const { locId } = req.params;
  const { week }  = req.query;
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  if (!week) return res.status(400).json({ error: 'week required (YYYY-MM-DD Monday)' });

  const dates    = weekDates(week);
  const schedule = {};

  dates.forEach(date => {
    const dvms  = db.prepare(`
      SELECT a.id, a.person_id, a.hours,
             COALESCE(a.break_hours, 0) as break_hours,
             COALESCE(a.time_off_hours, 0) as time_off_hours,
             d.name, d.specialty as sub, d.color
      FROM assignments a JOIN dvms d ON a.person_id = d.id
      WHERE a.location_id = ? AND a.date = ? AND a.person_type = 'dvm'
    `).all(locId, date);

    const staff = db.prepare(`
      SELECT a.id, a.person_id, a.hours,
             COALESCE(a.break_hours, 0) as break_hours,
             COALESCE(a.time_off_hours, 0) as time_off_hours,
             s.name, s.role_title as sub, s.color
      FROM assignments a JOIN support_staff s ON a.person_id = s.id
      WHERE a.location_id = ? AND a.date = ? AND a.person_type = 'staff'
    `).all(locId, date);

    const vcRow = db.prepare(
      'SELECT count, COALESCE(expected_revenue, 0) as expected_revenue FROM visit_counts WHERE location_id = ? AND date = ?'
    ).get(locId, date);

    schedule[date] = { dvms, staff, visitCount: vcRow ? vcRow.count : 0, expectedRevenue: vcRow ? vcRow.expected_revenue : 0 };
  });

  const settings = db.prepare('SELECT * FROM location_settings WHERE location_id = ?').get(locId)
    || { visits_per_dvm_hour: 2.5, support_per_dvm_hour: 1.5, support_comp_pct_target: 30 };

  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(locId);

  res.json({ schedule, settings, location });
});

app.put('/api/locations/:locId/schedule/:date', requireAuth, (req, res) => {
  const { locId, date } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });

  const { dvms, staff, visitCount, expectedRevenue } = req.body;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM assignments WHERE location_id = ? AND date = ?').run(locId, date);

    const insA = db.prepare(
      'INSERT INTO assignments (location_id, date, person_id, person_type, hours, break_hours, time_off_hours) VALUES (?,?,?,?,?,?,?)'
    );
    (dvms  || []).forEach(a => insA.run(locId, date, a.personId, 'dvm',   a.hours || 0, a.breakHours || 0, a.timeOffHours || 0));
    (staff || []).forEach(a => insA.run(locId, date, a.personId, 'staff', a.hours || 0, a.breakHours || 0, a.timeOffHours || 0));

    db.prepare(`
      INSERT INTO visit_counts (location_id, date, count, expected_revenue) VALUES (?,?,?,?)
      ON CONFLICT(location_id, date) DO UPDATE SET count = excluded.count, expected_revenue = excluded.expected_revenue
    `).run(locId, date, visitCount != null ? visitCount : 0, expectedRevenue != null ? expectedRevenue : 0);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ ok: true });
});

app.put('/api/locations/:locId/settings', requireAuth, (req, res) => {
  const { locId } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  const { visitsPerDVMHour, supportPerDVMHour, supportCompPctTarget } = req.body;
  db.prepare(`
    INSERT INTO location_settings (location_id, visits_per_dvm_hour, support_per_dvm_hour, support_comp_pct_target) VALUES (?,?,?,?)
    ON CONFLICT(location_id) DO UPDATE SET visits_per_dvm_hour=excluded.visits_per_dvm_hour, support_per_dvm_hour=excluded.support_per_dvm_hour, support_comp_pct_target=excluded.support_comp_pct_target
  `).run(locId, visitsPerDVMHour, supportPerDVMHour, supportCompPctTarget != null ? supportCompPctTarget : 30);
  res.json({ ok: true });
});

app.patch('/api/locations/:locId/staff/:id', requireAuth, (req, res) => {
  const { locId, id } = req.params;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  const { hourlyRate } = req.body;
  if (hourlyRate !== undefined) {
    db.prepare('UPDATE support_staff SET hourly_rate = ? WHERE id = ? AND location_id = ?')
      .run(Math.max(0, parseFloat(hourlyRate) || 0), id, locId);
  }
  res.json({ ok: true });
});

// ── CORPORATE ROLLUP ──────────────────────────────────────

app.get('/api/rollup', requireRole('corporate'), (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: 'week required' });

  const locations = db.prepare('SELECT * FROM locations ORDER BY name').all();
  const dates     = weekDates(week);

  const rollup = locations.map(loc => {
    const settings = db.prepare('SELECT * FROM location_settings WHERE location_id = ?').get(loc.id)
      || { visits_per_dvm_hour: 2.5, support_per_dvm_hour: 1.5 };

    const days = dates.map(date => {
      const dvmHours = db.prepare(`SELECT COALESCE(SUM(hours),0) as t FROM assignments WHERE location_id=? AND date=? AND person_type='dvm'`).get(loc.id, date).t;
      const supHours = db.prepare(`SELECT COALESCE(SUM(hours),0) as t FROM assignments WHERE location_id=? AND date=? AND person_type='staff'`).get(loc.id, date).t;
      const vcRow    = db.prepare('SELECT COALESCE(count, 0) as c FROM visit_counts WHERE location_id=? AND date=?').get(loc.id, date);
      const visits   = vcRow ? vcRow.c : 0;
      return { date, dvmHours, supHours, visits };
    });

    return { location: loc, settings, days };
  });

  res.json(rollup);
});

app.get('/api/rollup/:locId/:date', requireRole('corporate'), (req, res) => {
  const { locId, date } = req.params;
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(locId);
  if (!location) return res.status(404).json({ error: 'Not found' });

  const dvms  = db.prepare(`
    SELECT a.*, d.name, d.specialty as sub, d.color
    FROM assignments a JOIN dvms d ON a.person_id = d.id
    WHERE a.location_id=? AND a.date=? AND a.person_type='dvm'
  `).all(locId, date);

  const staff = db.prepare(`
    SELECT a.*, s.name, s.role_title as sub, s.color
    FROM assignments a JOIN support_staff s ON a.person_id = s.id
    WHERE a.location_id=? AND a.date=? AND a.person_type='staff'
  `).all(locId, date);

  const vcRow = db.prepare('SELECT COALESCE(count, 0) as c FROM visit_counts WHERE location_id=? AND date=?').get(locId, date);

  res.json({ location, dvms, staff, visitCount: vcRow ? vcRow.c : 0, date });
});

// ── TIME LOGS ─────────────────────────────────────────────

app.get('/api/timelog', requireAuth, (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: 'week required' });

  const personId   = req.session.role === 'staff' ? req.session.personId   : req.query.personId;
  const personType = req.session.role === 'staff' ? req.session.personType : req.query.personType;

  const dates = weekDates(week);
  const logs  = db.prepare(
    `SELECT * FROM time_logs WHERE person_id=? AND person_type=? AND date IN (${dates.map(() => '?').join(',')})`
  ).all(personId, personType, ...dates);

  const result = {};
  dates.forEach(d => { result[d] = null; });
  logs.forEach(l => { result[l.date] = l; });
  res.json(result);
});

app.put('/api/timelog', requireAuth, (req, res) => {
  const personId   = req.session.role === 'staff' ? req.session.personId   : req.body.personId;
  const personType = req.session.role === 'staff' ? req.session.personType : req.body.personType;
  const { date, hoursWorked, breakHours, isTimeOff, notes } = req.body;

  db.prepare(`
    INSERT INTO time_logs (person_id, person_type, date, hours_worked, break_hours, is_time_off, notes)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(person_id, person_type, date) DO UPDATE SET
      hours_worked=excluded.hours_worked, break_hours=excluded.break_hours,
      is_time_off=excluded.is_time_off, notes=excluded.notes
  `).run(personId, personType, date, hoursWorked ?? null, breakHours ?? 0, isTimeOff ? 1 : 0, notes ?? '');

  res.json({ ok: true });
});

// Time logs for a whole location (for managers)
app.get('/api/locations/:locId/timelogs', requireAuth, (req, res) => {
  const { locId } = req.params;
  const { week }  = req.query;
  if (req.session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
  if (!canAccessLocation(req, locId)) return res.status(403).json({ error: 'Forbidden' });
  if (!week) return res.status(400).json({ error: 'week required' });

  const dates = weekDates(week);
  const dvms  = db.prepare('SELECT * FROM dvms WHERE location_id=?').all(locId);
  const staff = db.prepare('SELECT * FROM support_staff WHERE location_id=?').all(locId);

  const result = [
    ...dvms.map(p  => ({ ...p, personType: 'dvm'   })),
    ...staff.map(p => ({ ...p, personType: 'staff' })),
  ].map(person => {
    const logs  = db.prepare(
      `SELECT * FROM time_logs WHERE person_id=? AND person_type=? AND date IN (${dates.map(() => '?').join(',')})`
    ).all(person.id, person.personType, ...dates);
    const byDate = {};
    dates.forEach(d => { byDate[d] = null; });
    logs.forEach(l => { byDate[l.date] = l; });
    return { person, logs: byDate };
  });

  res.json(result);
});

// ── START ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VetScheduler Pro running on http://localhost:${PORT}`);
});
