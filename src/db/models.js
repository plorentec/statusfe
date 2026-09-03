const { prepare, run, queryOne, queryAll } = require('./database');
const { v4: uuidv4 } = require('uuid');
const { sanitizeCss, sanitizeHtml } = require('../utils/sanitize');

let customizationCache = null;

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function formatDateInTZ(dateStr, tz) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const options = { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('es-ES', options);
  return formatter.format(d);
}

function nowInTZ(tz) {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: tz || 'UTC' }).replace(/\//g, '-').slice(0, 19).replace('T', ' ');
}

async function cascadeStatusChange(upstreamComponentId, newStatus) {
  const dependents = await queryAll('SELECT * FROM component_dependencies WHERE depends_on=$1', [upstreamComponentId]);
  if (dependents.length > 0) console.log('Cascading status', newStatus, 'from', upstreamComponentId, 'to', dependents.map(d => d.component_id).join(', '));
  for (const dep of dependents) {
    if (dep.cascade_status == 1) {
      const depComp = await queryOne('SELECT * FROM components WHERE id=$1', [dep.component_id]);
      if (depComp && depComp.status !== newStatus) {
        console.log('  Cascade:', depComp.name, depComp.status, '->', newStatus);
        await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, dep.component_id]);
        const dhId = uuidv4();
        try {
          await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [dhId, dep.component_id, null, depComp.status, newStatus]);
        } catch(e) {
          if (!e.message.includes('FOREIGN KEY')) throw e;
        }
      }
    }
  }
}

// ===== PAGES =====
module.exports.pages = {
  async list(filters = {}) {
    let q = 'SELECT * FROM pages WHERE 1=1';
    const p = [];
    if (filters.is_public !== undefined) { q += ' AND is_public=$' + (p.length + 1); p.push(filters.is_public ? 1 : 0); }
    if (filters.status) { q += ' AND status=$' + (p.length + 1); p.push(filters.status); }
    if (filters.slug) { q += ' AND slug=$' + (p.length + 1); p.push(filters.slug); }
    q += ' ORDER BY name';
    return queryAll(q, p);
  },

  async getById(id) { return await queryOne('SELECT * FROM pages WHERE id=$1', [id]); },
  async getBySlug(slug) { return await queryOne('SELECT * FROM pages WHERE slug=$1', [slug]); },
  async getByExternalId(ex_id) { if (!ex_id) return null; return await queryOne('SELECT * FROM pages WHERE external_id=$1', [ex_id]); },

  async create({ name, slug, description, status, timezone, logo_url, custom_css, custom_html, is_public, template, refresh_interval, custom_layout, custom_layout_css, custom_layout_html, external_id }) {
    const id = uuidv4();
    await run(
      'INSERT INTO pages (id,name,slug,description,status,template,timezone,logo_url,custom_css,custom_html,is_public,refresh_interval,custom_layout,custom_layout_css,custom_layout_html,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [id, name, slug, description||'', status||'operational', template||'default', timezone||'UTC', logo_url||null, sanitizeCss(custom_css)||null, sanitizeHtml(custom_html)||null, is_public ? 1 : 0, refresh_interval ? Math.max(15, parseInt(refresh_interval)) : 15, custom_layout ? 1 : 0, sanitizeCss(custom_layout_css)||null, sanitizeHtml(custom_layout_html)||null, external_id||null]
    );
    return this.getById(id);
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','slug','description','status','template','timezone','logo_url','custom_css','custom_html','is_public','refresh_interval','custom_layout','custom_layout_css','custom_layout_html','external_id'];
    for (const k of allowed) {
      if (data[k] !== undefined) {
        let val = data[k];
        if (k === 'refresh_interval') val = Math.max(15, parseInt(val) || 15);
        if (k === 'is_public') val = (val === 'on' || val === 1 || val === true) ? 1 : 0;
        if (k === 'custom_layout') val = (val === 'on' || val === 1 || val === true) ? 1 : 0;
        if (k === 'custom_css' || k === 'custom_layout_css') val = sanitizeCss(val);
        if (k === 'custom_html' || k === 'custom_layout_html') val = sanitizeHtml(val);
        fields.push(k+'=$'+(params.length+1));
        params.push(val);
      }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE pages SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    return this.getById(id);
  },

  async delete(id) { await run('DELETE FROM pages WHERE id=$1', [id]); return true; }
};

// ===== COMPONENTS =====
module.exports.components = {
  async list(filters = {}) {
    let q = 'SELECT * FROM components WHERE 1=1';
    const p = [];
    if (filters.status) { q += ' AND status=$' + (p.length + 1); p.push(filters.status); }
    q += ' ORDER BY position,name';
    let rows = await queryAll(q, p);
    const memberMap = await module.exports.components.getGroupsForMany(rows.map(r => r.id));
    for (const r of rows) r.groups = memberMap.get(r.id) || [];
    // Group filter matches ANY of the component's groups (membership or legacy name)
    if (filters.group) {
      const target = String(filters.group).toLowerCase();
      rows = rows.filter(r => String(r.group_name || '').toLowerCase() === target || r.groups.some(g => String(g.name).toLowerCase() === target));
    }
    return rows;
  },

  async get(id) { return await queryOne('SELECT * FROM components WHERE id=$1', [id]); },
  async getByExternalId(ex_id) { if (!ex_id) return null; return await queryOne('SELECT * FROM components WHERE external_id=$1', [ex_id]); },

  // Components displayed on a status page = union of:
  //   1. components individually assigned via page_components
  //   2. components whose group is assigned to this page (group_pages)
  //   3. components of global groups (groups with no page assignment)
  // Deduplicated; current_status resolves override_status, page/global history
  // and dependency cascade; group_name resolved from group_id (fallback legacy text).
  async getForPage(pageId) {
    const rows = await queryAll(`
      SELECT DISTINCT c.*, pc.position as pc_position,
        COALESCE(sh.new_status, c.status) as current_status
      FROM components c
      LEFT JOIN page_components pc ON pc.component_id = c.id AND pc.page_id = $1
      LEFT JOIN (
        SELECT DISTINCT ON (component_id) component_id, new_status
        FROM status_history
        WHERE page_id = $1 OR page_id IS NULL
        ORDER BY component_id, created_at DESC
      ) sh ON sh.component_id = c.id
      WHERE pc.component_id IS NOT NULL
         OR c.id IN (SELECT cgm.component_id FROM component_group_members cgm
                     JOIN group_pages gp ON gp.group_id = cgm.group_id WHERE gp.page_id = $1)
         OR c.id IN (SELECT cgm.component_id FROM component_group_members cgm
                     WHERE cgm.group_id IN (SELECT id FROM component_groups WHERE id NOT IN (SELECT group_id FROM group_pages)))
    `, [pageId]);

    const allGroups = await module.exports.componentGroups.list();
    const groupById = new Map(allGroups.map(g => [g.id, g]));

    // Groups displayed on this page = groups bound via group_pages + global groups
    // (groups with no group_pages rows appear on every page).
    const displayedGroupIds = new Set([
      ...(await queryAll('SELECT group_id FROM group_pages WHERE page_id=$1', [pageId])).map(r => r.group_id),
      ...(await queryAll('SELECT id FROM component_groups WHERE id NOT IN (SELECT group_id FROM group_pages)', [])).map(r => r.id)
    ]);

    // Memberships for the fetched components (component_id -> Set(group_id))
    const memberships = new Map();
    if (rows.length) {
      const memberRows = await queryAll(
        `SELECT component_id, group_id FROM component_group_members WHERE component_id IN (${rows.map((_, i) => '$' + (i + 1)).join(',')})`,
        rows.map(r => r.id)
      );
      for (const m of memberRows) {
        if (!memberships.has(m.component_id)) memberships.set(m.component_id, new Set());
        memberships.get(m.component_id).add(m.group_id);
      }
    }

    const result = [];
    for (const c of rows) {
      // Resolve effective status once per component (override / dependency cascade)
      let currentStatus = c.current_status;
      if (c.override_status) {
        currentStatus = c.override_status;
      } else {
        const deps = await module.exports.dependencies.listDependsOnComponent(c.id);
        for (const dep of deps) {
          if (!dep.cascade_status) continue;
          const depComp = await module.exports.components.get(dep.depends_on);
          if (depComp && depComp.status !== 'operational') {
            currentStatus = depComp.status;
            break;
          }
        }
      }

      const memberGroups = [...(memberships.get(c.id) || [])]
        .map(gid => groupById.get(gid)).filter(Boolean);
      const displayed = memberGroups.filter(g => displayedGroupIds.has(g.id));

      if (displayed.length > 0) {
        // A component in multiple groups appears under each displayed group.
        for (const g of displayed) {
          result.push({ ...c, current_status: currentStatus, group_name: g.name, group_position: g.position });
        }
      } else {
        // Directly assigned to the page but not in any displayed group: fall back
        // to the component's primary/legacy group label, else 'Other'.
        const fb = c.group_id ? groupById.get(c.group_id) : null;
        result.push({
          ...c,
          current_status: currentStatus,
          group_name: c.group_name || 'Other',
          group_position: fb ? fb.position : Number.MAX_SAFE_INTEGER
        });
      }
    }

    result.sort((a, b) => {
      if (a.group_position !== b.group_position) return a.group_position - b.group_position;
      const pa = a.pc_position != null ? a.pc_position : 1000000 + (a.position || 0);
      const pb = b.pc_position != null ? b.pc_position : 1000000 + (b.position || 0);
      if (pa !== pb) return pa - pb;
      return String(a.name).localeCompare(String(b.name));
    });
    return result;
  },

  async create({ name, description, status, group_name, group_id, group_ids, position, external_id }) {
    const id = uuidv4();
    await run(
      'INSERT INTO components (id,name,description,status,group_name,group_id,external_id,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, name, description||'', status||'operational', group_name||null, group_id||null, external_id||null, position||0]
    );
    const gids = (group_ids && group_ids.length) ? group_ids : (group_id ? [group_id] : []);
    if (gids.length) await this.setGroups(id, gids);
    return this.get(id);
  },

  // Resolve groups for a component payload: supports a single group_id (legacy),
  // a group_ids array (many-to-many), and new_group_name (find-or-create, wins).
  // Returns { group_id, group_name, group_ids } with canonical names synced.
  async resolveGroup({ group_id, group_ids, new_group_name }) {
    let ids = [];
    if (Array.isArray(group_ids)) ids = group_ids.filter(Boolean);
    else if (typeof group_ids === 'string' && group_ids) ids = group_ids.split(',').map(s => s.trim()).filter(Boolean);
    else if (group_id) ids = [group_id];
    const newName = String(new_group_name || '').trim();
    if (newName) {
      const group = await module.exports.componentGroups.findOrCreateByName(newName);
      if (group && !ids.includes(group.id)) ids.unshift(group.id);
    }
    // Validate + dedupe, preserving order
    const unique = [];
    for (const id of ids) {
      const g = await module.exports.componentGroups.get(id);
      if (g && !unique.includes(g.id)) unique.push(g.id);
    }
    const finalGroupId = unique.length ? unique[0] : null;
    let finalGroupName = null;
    if (finalGroupId) {
      const g = await module.exports.componentGroups.get(finalGroupId);
      if (g) finalGroupName = g.name;
    }
    return { group_id: finalGroupId, group_name: finalGroupName, group_ids: unique };
  },

  async update(id, data) {
    const oldComp = await this.get(id);
    const fields = [];
    const params = [];
    const allowed = ['name','description','status','group_name','group_id','position','external_id'];
    for (const k of allowed) {
      if (data[k] !== undefined) {
        let val = data[k];
        if ((k === 'group_id' || k === 'group_name') && (val === '' || val === null)) val = null;
        fields.push(k+'=$'+(params.length+1)); params.push(val);
      }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE components SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    // Keep the many-to-many memberships in sync with the group fields.
    if (data.group_ids !== undefined) {
      await this.setGroups(id, data.group_ids);
    } else if (data.group_id !== undefined) {
      await this.setGroups(id, data.group_id ? [data.group_id] : []);
    }
    if (data.status && oldComp.status !== data.status) {
      const pages = await queryAll('SELECT page_id FROM page_components WHERE component_id=$1', [id]);
      for (const pc of pages) {
        const hId = uuidv4();
        await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, id, pc.page_id, oldComp.status, data.status]);
      }
      const hId2 = uuidv4();
      try {
        await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId2, id, null, oldComp.status, data.status]);
      } catch(e) {
        if (!e.message.includes('FOREIGN KEY')) throw e;
      }
      await cascadeStatusChange(id, data.status);
    }
    return this.get(id);
  },

  async delete(id) { await run('DELETE FROM components WHERE id=$1', [id]); return true; },

  // Get the groups a component belongs to (ordered).
  async getGroups(componentId) {
    return await queryAll(
      'SELECT g.* FROM component_groups g JOIN component_group_members cgm ON cgm.group_id = g.id WHERE cgm.component_id=$1 ORDER BY g.position, g.name',
      [componentId]
    );
  },

  // Sync a component's group memberships. The first group becomes the legacy
  // primary group_id/group_name (kept for backwards-compatible queries/display).
  async setGroups(componentId, groupIds) {
    let ids = [];
    if (Array.isArray(groupIds)) ids = groupIds.filter(Boolean);
    else if (typeof groupIds === 'string' && groupIds) ids = groupIds.split(',').map(s => s.trim()).filter(Boolean);
    const unique = [...new Set(ids)];
    await run('DELETE FROM component_group_members WHERE component_id=$1', [componentId]);
    for (const gid of unique) {
      const g = await module.exports.componentGroups.get(gid);
      if (g) await run('INSERT INTO component_group_members (component_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [componentId, gid]);
    }
    const primary = unique[0] || null;
    if (primary) {
      const g = await module.exports.componentGroups.get(primary);
      await run('UPDATE components SET group_id=$1, group_name=$2 WHERE id=$3', [primary, g ? g.name : null, componentId]);
    } else {
      await run('UPDATE components SET group_id=NULL WHERE id=$1', [componentId]);
    }
    return await this.getGroups(componentId);
  },

  // Map component_id -> array of group objects for a batch of component ids.
  async getGroupsForMany(componentIds) {
    const map = new Map();
    if (!componentIds || componentIds.length === 0) return map;
    const members = await queryAll(
      `SELECT component_id, group_id FROM component_group_members WHERE component_id IN (${componentIds.map((_, i) => '$' + (i + 1)).join(',')})`,
      componentIds
    );
    if (members.length === 0) return map;
    const groupIds = [...new Set(members.map(m => m.group_id))];
    const groups = await queryAll(`SELECT * FROM component_groups WHERE id IN (${groupIds.map((_, i) => '$' + (i + 1)).join(',')})`, groupIds);
    const groupById = new Map(groups.map(g => [g.id, g]));
    for (const m of members) {
      const g = groupById.get(m.group_id);
      if (g) {
        if (!map.has(m.component_id)) map.set(m.component_id, []);
        map.get(m.component_id).push(g);
      }
    }
    return map;
  },

  async assignToPage(pageId, componentId, position) {
    const page = await module.exports.pages.getById(pageId) || await module.exports.pages.getBySlug(pageId);
    if (!page) throw new Error('Page not found');
    const comp = await this.get(componentId);
    if (!comp) throw new Error('Component not found');
    await run('INSERT INTO page_components (page_id,component_id,position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [page.id, componentId, position||0]);
    return true;
  },

  async removeFromPage(pageId, componentId) {
    const page = await module.exports.pages.getById(pageId) || await module.exports.pages.getBySlug(pageId);
    const effectivePageId = page ? page.id : pageId;
    await run('DELETE FROM page_components WHERE page_id=$1 AND component_id=$2', [effectivePageId, componentId]);
    return true;
  },

  async updateStatus(componentId, newStatus, pageIdOrSlug, override) {
    const comp = await this.get(componentId);
    if (!comp) throw new Error('Component not found');

    const oldStatus = comp.status;
    if (oldStatus === newStatus) return { component: comp, history: null };

    if (override) {
      await run('UPDATE components SET status=$1, override_status=$1, updated_at=NOW() WHERE id=$2', [newStatus, componentId]);
    } else {
      await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, componentId]);
    }

    let pageId = pageIdOrSlug;
    if (pageId && !isUUID(pageId)) {
      const page = await module.exports.pages.getBySlug(pageId);
      if (page) pageId = page.id;
    }

    const hId = uuidv4();
    const effectivePageId = (pageId && isUUID(pageId)) ? pageId : null;
    try {
      await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, componentId, effectivePageId, oldStatus, newStatus]);
    } catch(e) {
      if (e.message.includes('FOREIGN KEY')) {
        await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, componentId, null, oldStatus, newStatus]);
      } else throw e;
    }

    let pageTitle = 'Status Page';
    if (pageId) {
      const p = await module.exports.pages.getById(pageId);
      if (p) pageTitle = p.name;
    }
    const email = require('../utils/email');
    email.notifyComponentStatusChange(comp.name, oldStatus, newStatus, pageTitle).catch(() => {});

    await cascadeStatusChange(componentId, newStatus);

    return {
      component: await this.get(componentId),
      history: await queryOne('SELECT * FROM status_history WHERE id=$1', [hId])
    };
  },

  async getHistory(componentId, pageId, limit=50) {
    let q = 'SELECT * FROM status_history WHERE component_id=$1';
    const p = [componentId];
    if (pageId) { q += ' AND page_id=$' + (p.length + 1); p.push(pageId); }
    q += ' ORDER BY created_at DESC LIMIT $' + (p.length + 1);
    p.push(limit);
    return await queryAll(q, p);
  },

  async getWithPages(componentId) {
    const comp = await this.get(componentId);
    if (!comp) return null;
    comp.pages = await queryAll(
      'SELECT p.* FROM pages p JOIN page_components pc ON p.id = pc.page_id WHERE pc.component_id=$1 ORDER BY p.name',
      [componentId]
    );

    comp.status_by_page = {};
    for (const p of comp.pages) {
      const latest = await queryOne(
        'SELECT new_status, old_status, created_at FROM status_history WHERE component_id=$1 AND page_id=$2 ORDER BY created_at DESC LIMIT 1',
        [componentId, p.id]
      );
      if (latest) comp.status_by_page[p.slug] = latest;
    }
    return comp;
  },

  async getActiveIncidents(componentId) {
    return await queryAll(
      'SELECT * FROM incidents WHERE component_id=$1 AND status != \'resolved\' ORDER BY starts_at DESC',
      [componentId]
    );
  },

  async getActiveIncidentForComponent(componentId, pageId) {
    if (pageId) {
      return await queryOne(
        'SELECT * FROM incidents WHERE component_id=$1 AND page_id=$2 AND status != \'resolved\' ORDER BY starts_at DESC LIMIT 1',
        [componentId, pageId]
      );
    }
    return await queryOne(
      'SELECT * FROM incidents WHERE component_id=$1 AND status != \'resolved\' ORDER BY starts_at DESC LIMIT 1',
      [componentId]
    );
  }
};

// ===== INCIDENTS =====
module.exports.incidents = {
  async list(filters = {}) {
    let q = 'SELECT * FROM incidents WHERE 1=1';
    const p = [];
    if (filters.page_id) { q += ' AND page_id=$' + (p.length + 1); p.push(filters.page_id); }
    if (filters.component_id) { q += ' AND component_id=$' + (p.length + 1); p.push(filters.component_id); }
    if (filters.status) { q += ' AND status=$' + (p.length + 1); p.push(filters.status); }
    if (filters.visible !== undefined) { q += ' AND visible=$' + (p.length + 1); p.push(filters.visible ? 1 : 0); }
    q += ' ORDER BY starts_at DESC';
    if (filters.limit) { q += ' LIMIT $' + (p.length + 1); p.push(filters.limit); }
    return await queryAll(q, p);
  },

  async get(id) { return await queryOne('SELECT * FROM incidents WHERE id=$1', [id]); },

  async getFirstByComponentAndPage(componentId, pageId) {
    return await queryOne(
      'SELECT * FROM incidents WHERE component_id=$1 AND page_id=$2 AND status != \'resolved\' ORDER BY starts_at DESC LIMIT 1',
      [componentId, pageId]
    );
  },

  async create({ component_id, page_id, name, status, impact, starts_at, resolved_at, message, visible, cascade_status }) {
    const id = uuidv4();
    let resolvedPageId = page_id;
    if (component_id && !page_id) {
      const pageComp = await queryOne('SELECT page_id FROM page_components WHERE component_id=$1 LIMIT 1', [component_id]);
      if (pageComp) resolvedPageId = pageComp.page_id;
    }
    if (!resolvedPageId) return null;

    const cs = cascade_status || 'same';
    const serverTZ = await module.exports.settings.get('server_timezone') || 'UTC';
    await run(
      'INSERT INTO incidents (id,component_id,page_id,name,status,impact,starts_at,resolved_at,message,visible,cascade_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, component_id||null, resolvedPageId, name, status||'investigating', impact||'none', starts_at||nowInTZ(serverTZ), resolved_at||null, message, visible ? 1 : 0, cs]
    );

    if (component_id && status !== 'resolved' && cs !== 'none') {
      const incidentStatus = status || 'investigating';
      const comp = await this.get(component_id);
      let newStatus;
      if (cs === 'same') {
        newStatus = incidentStatus;
      } else if (cs === 'criticality') {
        newStatus = module.exports.statusMappings.resolve(incidentStatus);
        if (!newStatus) {
          if (incidentStatus === 'investigating') newStatus = 'major_outage';
          else if (incidentStatus === 'identified') newStatus = 'partial_outage';
          else if (incidentStatus === 'monitoring') newStatus = 'degraded_performance';
          else if (incidentStatus === 'resolved') newStatus = 'operational';
        }
      }
      const oldStatus = comp ? comp.status : 'operational';
      if (newStatus && oldStatus !== newStatus) {
        await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, component_id]);
        const hId = uuidv4();
        try {
          await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, component_id, resolvedPageId, oldStatus, newStatus]);
        } catch(e) {
          if (!e.message.includes('FOREIGN KEY')) throw e;
        }
        await cascadeStatusChange(component_id, newStatus);
      }
    }

    const inc = await this.get(id);
    const page = await module.exports.pages.getById(resolvedPageId);
    const comp = component_id ? await module.exports.components.get(component_id) : null;
    const email = require('../utils/email');
    const compName = comp ? comp.name : 'Status Page';
    email.notifyIncident(true, name, status, message, page ? page.name : compName).catch(() => {});
    return inc;
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','status','impact','starts_at','resolved_at','message','visible','component_id','cascade_status'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (data.status === 'resolved' && !('resolved_at' in data)) {
      fields.push('resolved_at=$'+(params.length+1));
      const serverTZ = await module.exports.settings.get('server_timezone') || 'UTC';
      params.push(nowInTZ(serverTZ));
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE incidents SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    const inc = await this.get(id);
    if (inc && inc.component_id) {
      const cs = data.cascade_status || inc.cascade_status || 'same';
      console.log('Incident update:', id, 'status:', data.status, 'cs:', cs);
      if (data.status && data.status !== 'resolved' && cs !== 'none') {
        let newStatus;
        if (cs === 'same') {
          newStatus = data.status;
        } else {
          newStatus = module.exports.statusMappings.resolve(data.status);
          if (!newStatus) {
            if (data.status === 'investigating') newStatus = 'major_outage';
            else if (data.status === 'identified') newStatus = 'partial_outage';
            else if (data.status === 'monitoring') newStatus = 'degraded_performance';
            else if (data.status === 'resolved') newStatus = 'operational';
          }
        }
        const comp = await module.exports.components.get(inc.component_id);
        if (newStatus && comp && comp.status !== newStatus) {
          await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, inc.component_id]);
          const hId = uuidv4();
          try {
            await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, inc.component_id, inc.page_id, comp.status, newStatus]);
          } catch(e) {
            if (!e.message.includes('FOREIGN KEY')) throw e;
          }
          await cascadeStatusChange(inc.component_id, newStatus);
        }
      }
      if (data.status === 'resolved') {
        const activeIncidents = await queryAll('SELECT id FROM incidents WHERE component_id=$1 AND status != \'resolved\'', [inc.component_id]);
        if (activeIncidents.length === 0) {
          const comp = await module.exports.components.get(inc.component_id);
          if (comp && comp.status !== 'operational') {
            await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', ['operational', inc.component_id]);
            const hId = uuidv4();
            try {
              await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES ($1,$2,$3,$4,$5)', [hId, inc.component_id, inc.page_id, comp.status, 'operational']);
            } catch(e) {
              if (!e.message.includes('FOREIGN KEY')) throw e;
            }
            await cascadeStatusChange(inc.component_id, 'operational');
          }
        }
      }
      const page = await module.exports.pages.getById(inc.page_id);
      const comp = inc.component_id ? await module.exports.components.get(inc.component_id) : null;
      const compName = comp ? comp.name : 'Status Page';
      const email = require('../utils/email');
      email.notifyIncident(false, inc.name, inc.status, data.message || '', page ? page.name : compName).catch(() => {});
    }
    return inc;
  },

  async delete(id) { await run('DELETE FROM incidents WHERE id=$1', [id]); return true; }
};

// ===== API KEYS =====
module.exports.apiKeys = {
  async list(pageId) {
    let q = 'SELECT id,key_prefix,name,permissions,page_id,is_active,last_used_at,created_at,expires_at FROM api_keys WHERE 1=1';
    const p = [];
    if (pageId) { q += ' AND page_id=$' + (p.length + 1); p.push(pageId); }
    q += ' ORDER BY created_at DESC';
    const rows = await queryAll(q, p);
    return rows.map(r => ({...r, permissions: r.permissions ? JSON.parse(r.permissions) : []}));
  },

  async getFull(id) {
    const r = await queryOne('SELECT id,key,name,permissions,page_id,is_active,last_used_at,created_at,expires_at FROM api_keys WHERE id=$1', [id]);
    return r ? {...r, permissions: r.permissions ? JSON.parse(r.permissions) : []} : null;
  },

  async create({ name, permissions, page_id, rate_limit, expires_at }) {
    const id = uuidv4();
    const key = uuidv4() + '-' + uuidv4();
    const hash = require('bcryptjs').hashSync(key, 10);
    await run(
      'INSERT INTO api_keys (id,key_hash,key,key_prefix,name,permissions,page_id,rate_limit,is_active,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, hash, key, key.substring(0,8), name, JSON.stringify(permissions||['read']), page_id||null, rate_limit||100, 1, expires_at||null]
    );
    return { id, key, key_prefix: key.substring(0,8), name, permissions: permissions||['read'], page_id, rate_limit: rate_limit||100, is_active: true, created_at: new Date().toISOString(), expires_at };
  },

  async revoke(id) { await run('UPDATE api_keys SET is_active=0 WHERE id=$1', [id]); return true; },
  async activate(id) { await run('UPDATE api_keys SET is_active=1 WHERE id=$1', [id]); return true; },
  async permanentDelete(id) { await run('DELETE FROM api_keys WHERE id=$1', [id]); return true; },

  async authenticate(key) {
    if (!key) return null;
    // Lookup by prefix first (index-friendly) instead of bcrypt-comparing every
    // active key on each request.
    const prefix = String(key).substring(0, 8);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const rows = await queryAll(
      'SELECT * FROM api_keys WHERE is_active=1 AND key_prefix=$1 AND (expires_at IS NULL OR expires_at > $2)',
      [prefix, now]
    );
    const bcrypt = require('bcryptjs');
    for (const r of rows) {
      if (bcrypt.compareSync(key, r.key_hash)) {
        // Throttle last_used_at writes to ~1/minute per key (was: one UPDATE per request)
        const stale = !r.last_used_at || (Date.now() - new Date(r.last_used_at).getTime() > 60 * 1000);
        if (stale) run('UPDATE api_keys SET last_used_at=NOW() WHERE id=$1', [r.id]).catch(() => {});
        const page = await queryOne('SELECT slug FROM pages WHERE id=$1', [r.page_id]);
        return { id: r.id, name: r.name, permissions: JSON.parse(r.permissions), page_id: r.page_id, page_slug: page?.slug, rate_limit: r.rate_limit };
      }
    }
    return null;
  }
};

// ===== WEBHOOKS =====
module.exports.webhooks = {
  async list(pageId) { return await queryAll('SELECT * FROM webhooks WHERE page_id=$1 ORDER BY created_at DESC', [pageId]); },
  async create({ page_id, url, events, secret }) {
    const id = uuidv4();
    await run('INSERT INTO webhooks (id,page_id,url,events,is_active,secret) VALUES ($1,$2,$3,$4,$5,$6)', [id, page_id, url, JSON.stringify(events||['status.updated','incident.created']), 1, secret||null]);
    return await queryOne('SELECT * FROM webhooks WHERE id=$1', [id]);
  },
  async update(id, data) {
    const fields = [];
    const params = [];
    for (const k of ['url','events','is_active','secret']) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(k==='events' ? JSON.stringify(data[k]) : data[k]); }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE webhooks SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    return await queryOne('SELECT * FROM webhooks WHERE id=$1', [id]);
  },
  async delete(id) { await run('DELETE FROM webhooks WHERE id=$1', [id]); return true; }
};

// ===== MAINTENANCE =====
module.exports.maintenance = {
  async list(filters = {}) {
    let q = 'SELECT * FROM maintenance_windows WHERE 1=1';
    const p = [];
    if (filters.page_id) { q += ' AND page_id=$' + (p.length + 1); p.push(filters.page_id); }
    if (filters.status) { q += ' AND status=$' + (p.length + 1); p.push(filters.status); }
    q += ' ORDER BY starts_at ASC';
    return await queryAll(q, p);
  },

  async get(id) {
    const win = await queryOne('SELECT * FROM maintenance_windows WHERE id=$1', [id]);
    if (!win) return null;
    const pages = await queryAll('SELECT page_id FROM maintenance_notice_pages WHERE maintenance_id=$1', [id]);
    win.notice_pages = pages.map(r => r.page_id);
    return win;
  },

  async create({ page_id, component_id, title, description, starts_at, ends_at, advance_notice_minutes, notice_page_ids }) {
    const id = uuidv4();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const status = new Date(starts_at) > new Date() ? 'upcoming' : (new Date(ends_at) > new Date() ? 'ongoing' : 'completed');
    await run(
      'INSERT INTO maintenance_windows (id,page_id,component_id,title,description,starts_at,ends_at,status,advance_notice_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, page_id, component_id||null, title, description||'', starts_at, ends_at, status, advance_notice_minutes||0]
    );
    if (notice_page_ids && notice_page_ids.length) {
      for (const pid of notice_page_ids) {
        await run('INSERT INTO maintenance_notice_pages (id,maintenance_id,page_id) VALUES ($1,$2,$3)', [uuidv4(), id, pid]);
      }
    }
    return this.get(id);
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['page_id','component_id','title','description','starts_at','ends_at','status','advance_notice_minutes'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE maintenance_windows SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    if (data.notice_page_ids !== undefined) {
      await run('DELETE FROM maintenance_notice_pages WHERE maintenance_id=$1', [id]);
      for (const pid of data.notice_page_ids) {
        await run('INSERT INTO maintenance_notice_pages (id,maintenance_id,page_id) VALUES ($1,$2,$3)', [uuidv4(), id, pid]);
      }
    }
    return this.get(id);
  },

  async delete(id) { await run('DELETE FROM maintenance_windows WHERE id=$1', [id]); return true; },

  async updateStatuses() {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await run("UPDATE maintenance_windows SET status='ongoing' WHERE status='upcoming' AND starts_at<=$1", [now]);
    await run("UPDATE maintenance_windows SET status='completed' WHERE status='ongoing' AND ends_at<=$1", [now]);
    return true;
  },

  async getUpcomingForPage(pageId) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let q = `SELECT m.* FROM maintenance_windows m
      INNER JOIN maintenance_notice_pages mnp ON mnp.maintenance_id = m.id
      WHERE mnp.page_id = $1 AND m.status IN ('upcoming','ongoing')
        AND (m.starts_at <= $2 OR m.starts_at - (COALESCE(m.advance_notice_minutes, 0)::text || ' minutes')::interval <= $2)
      ORDER BY m.starts_at ASC`;
    return await queryAll(q, [pageId, now]);
  }
};

// ===== NOTIFICATIONS =====
module.exports.notifications = {
  async list(userId, limit=50) {
    return await queryAll('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
  },

  async listUnread(userId) {
    const result = await queryOne('SELECT COUNT(*) as count FROM notifications WHERE user_id=$1 AND is_read=0', [userId]);
    return result.count ? parseInt(result.count) : 0;
  },

  async create({ user_id, page_id, component_id, type, title, message }) {
    const id = uuidv4();
    await run('INSERT INTO notifications (id,user_id,page_id,component_id,type,title,message) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, user_id||null, page_id||null, component_id||null, type, title, message||'']);
    return await this.getById(id);
  },

  async getById(id) { return await queryOne('SELECT * FROM notifications WHERE id=$1', [id]); },

  async markRead(id) { await run('UPDATE notifications SET is_read=1 WHERE id=$1', [id]); return true; },

  async markAllRead(userId) { await run('UPDATE notifications SET is_read=1 WHERE user_id=$1', [userId]); return true; },

  async delete(id) { await run('DELETE FROM notifications WHERE id=$1', [id]); return true; }
};

// ===== ANALYTICS =====
module.exports.analytics = {
  async recordView(pageId, ip, userAgent, referrer) {
    const id = uuidv4();
    await run('INSERT INTO page_views (id,page_id,ip,user_agent,referrer) VALUES ($1,$2,$3,$4,$5)', [id, pageId, ip||'', userAgent||'', referrer||'']);
  },

  async getViews(pageId, days) {
    const retention = await module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    return await queryAll(
      'SELECT DATE(created_at) as date, COUNT(*) as views FROM page_views WHERE page_id=$1 AND created_at >= NOW() - ($2::text || \' days\')::interval GROUP BY DATE(created_at) ORDER BY date DESC',
      [pageId, effectiveDays]
    );
  },

  async getTotalViews(pageId) {
    const result = await queryOne('SELECT COUNT(*) as count FROM page_views WHERE page_id=$1', [pageId]);
    return result.count ? parseInt(result.count) : 0;
  },

  async getRecentViews(pageId, limit=20) {
    return await queryAll('SELECT * FROM page_views WHERE page_id=$1 ORDER BY created_at DESC LIMIT $2', [pageId, limit]);
  },

  async getUptime(pageId, days) {
    const retention = await module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const rows = await queryAll(
      'SELECT sh.component_id, sh.new_status, DATE(sh.created_at) as date FROM status_history sh JOIN page_components pc ON sh.component_id = pc.component_id WHERE pc.page_id=$1 AND sh.created_at >= NOW() - ($2::text || \' days\')::interval',
      [pageId, effectiveDays]
    );

    const componentStatuses = {};
    rows.forEach(r => {
      if (!componentStatuses[r.component_id]) componentStatuses[r.component_id] = {};
      if (!componentStatuses[r.component_id][r.date]) {
        componentStatuses[r.component_id][r.date] = r.new_status;
      }
    });

    let totalDays = 0;
    let operationalDays = 0;

    const pageCompIds = await queryAll('SELECT component_id FROM page_components WHERE page_id=$1', [pageId]);
    const allComponentIds = new Set(pageCompIds.map(pc => pc.component_id));

    for (let i = 0; i < effectiveDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      totalDays++;

      let allOperational = true;
      for (const compId of allComponentIds) {
        const statuses = componentStatuses[compId];
        const status = statuses ? statuses[dateStr] : 'operational';
        if (status !== 'operational') {
          allOperational = false;
          break;
        }
      }
      if (allOperational) operationalDays++;
    }

    return {
      percentage: totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00',
      days: effectiveDays,
      operationalDays,
      totalDays
    };
  },

  async getComponentUptime(componentId, days) {
    const retention = await module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const rows = await queryAll(
        'SELECT new_status, DATE(created_at) as date FROM status_history WHERE component_id=$1 AND created_at >= NOW() - ($2::text || \' days\')::interval ORDER BY created_at DESC',
      [componentId, effectiveDays]
    );

    const componentStatuses = {};
    rows.forEach(r => {
      if (!componentStatuses[r.date]) componentStatuses[r.date] = r.new_status;
    });

    let totalDays = 0;
    let operationalDays = 0;

    for (let i = 0; i < effectiveDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      totalDays++;
      const status = componentStatuses[dateStr];
      if (status === 'operational' || !status) operationalDays++;
    }

    return {
      percentage: totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00',
      days: effectiveDays,
      operationalDays,
      totalDays
    };
  },

  async getAllComponentsUptime(days) {
    const retention = await module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const components = await queryAll('SELECT DISTINCT c.id, c.name FROM components c ORDER BY c.name');
    const results = [];

    for (const comp of components) {
      const rows = await queryAll(
      'SELECT new_status, DATE(created_at) as date FROM status_history WHERE component_id=$1 AND created_at >= NOW() - ($2::text || \' days\')::interval ORDER BY created_at DESC',
        [comp.id, effectiveDays]
      );

      const dayStatuses = {};
      rows.forEach(r => {
        if (!dayStatuses[r.date]) dayStatuses[r.date] = r.new_status;
      });

      let totalDays = 0;
      let operationalDays = 0;

      for (let i = 0; i < effectiveDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        totalDays++;
        const status = dayStatuses[dateStr];
        if (status === 'operational' || !status) operationalDays++;
      }

      const uptime = totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00';

      const history = await queryAll(
        'SELECT new_status, created_at FROM status_history WHERE component_id=$1 AND created_at >= NOW() - ($2::text || \' days\')::interval ORDER BY created_at DESC LIMIT 30',
        [comp.id, effectiveDays]
      );

      results.push({
        id: comp.id,
        name: comp.name,
        uptime,
        operationalDays,
        totalDays,
        history: history.slice(0, 30)
      });
    }

    return results;
  },

  async cleanOldData() {
    const retention = await module.exports.settings.get('analytics_retention_days');
    if (!retention) return 0;
    const days = parseInt(retention);
    let deleted = 0;
    const viewsDeleted = await run("DELETE FROM page_views WHERE created_at < NOW() - ($1::text || ' days')::interval", [days]);
    deleted += viewsDeleted.changes;
    const histDeleted = await run("DELETE FROM status_history WHERE created_at < NOW() - ($1::text || ' days')::interval", [days]);
    deleted += histDeleted.changes;
    return deleted;
  }
};

// ===== SETTINGS =====
module.exports.settings = {
  async get(key) {
    const row = await queryOne('SELECT value FROM settings WHERE key=$1', [key]);
    return row ? row.value : null;
  },
  async set(key, value) {
    await run('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)]);
    return true;
  },
  async getSMTP() {
    return {
      host: await this.get('smtp_host'),
      port: await this.get('smtp_port'),
      user: await this.get('smtp_user'),
      pass: await this.get('smtp_pass'),
      secure: await this.get('smtp_secure'),
      from: await this.get('smtp_from'),
      from_name: await this.get('smtp_from_name'),
    };
  },
  async setSMTP(data) {
    const fields = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure','smtp_from','smtp_from_name'];
    for (const k of fields) {
      await this.set(k, data[k] !== undefined ? data[k] : '');
    }
    return true;
  },

  // Global status-page theme (admin Customize page). Values override the
  // --bg/--text/--radius variables already defined in status.css :root and add
  // --sf-primary/--sf-secondary. Cached in memory; cache is invalidated on save.
  async getCustomization() {
    if (customizationCache) return customizationCache;
    // Legacy guard: the old broken Customize form stored the literal string
    // "undefined" — treat it as missing.
    const get = async (key, def) => {
      const v = await this.get(key);
      return (v && v !== 'undefined') ? v : def;
    };
    const c = {
      primary_color: await get('custom_primary_color', '#10b981'),
      secondary_color: await get('custom_secondary_color', '#059669'),
      bg_color: await get('custom_bg_color', '#ffffff'),
      text_color: await get('custom_text_color', '#1e293b'),
      font_family: await get('custom_font_family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"),
      logo_text: await get('custom_logo_text', 'StatusFe'),
      logo_color: await get('custom_logo_color', '#10b981'),
      border_radius: await get('custom_border_radius', '12'),
    };
    customizationCache = c;
    return c;
  },

  async setCustomization(data) {
    const map = {
      primary_color: 'custom_primary_color',
      secondary_color: 'custom_secondary_color',
      bg_color: 'custom_bg_color',
      text_color: 'custom_text_color',
      font_family: 'custom_font_family',
      logo_text: 'custom_logo_text',
      logo_color: 'custom_logo_color',
      border_radius: 'custom_border_radius',
    };
    for (const [k, settingKey] of Object.entries(map)) {
      if (data[k] !== undefined && data[k] !== '') await this.set(settingKey, data[k]);
    }
    customizationCache = null;
    return true;
  },
  async delete(key) { await run('DELETE FROM settings WHERE key=$1', [key]); return true; }
};

// ===== COMPONENT DEPENDENCIES =====
module.exports.dependencies = {
  async list(componentId) { return await queryAll('SELECT * FROM component_dependencies WHERE component_id=$1', [componentId]); },
  async listByDependsOn(dependsOnId) { return await queryAll('SELECT * FROM component_dependencies WHERE depends_on=$1', [dependsOnId]); },
  async listDependsOnComponent(componentId) { return await queryAll('SELECT * FROM component_dependencies WHERE component_id=$1', [componentId]); },

  async create({ component_id, depends_on, cascade_status }) {
    const id = uuidv4();
    await run('INSERT INTO component_dependencies (id,component_id,depends_on,cascade_status) VALUES ($1,$2,$3,$4)', [id, component_id, depends_on, cascade_status ? 1 : 0]);
    return await this.getById(id);
  },

  async getById(id) { return await queryOne('SELECT * FROM component_dependencies WHERE id=$1', [id]); },

  async delete(id) { await run('DELETE FROM component_dependencies WHERE id=$1', [id]); return true; },

  async deleteByComponent(componentId) {
    await run('DELETE FROM component_dependencies WHERE component_id=$1 OR depends_on=$2', [componentId, componentId]);
    return true;
  }
};

// ===== PASSWORD RESETS =====
module.exports.passwordResets = {
  async create(userId, expiresHours) {
    const id = uuidv4();
    const token = uuidv4() + '-' + uuidv4();
    const expiresAt = new Date(Date.now() + expiresHours * 3600000).toISOString();
    await run('INSERT INTO password_resets (id, user_id, token, expires_at) VALUES ($1,$2,$3,$4)', [id, userId, token, expiresAt]);
    return token;
  },

  async get(token) {
    return await queryOne(
      'SELECT pr.*, u.email, u.name FROM password_resets pr JOIN users u ON pr.user_id = u.id WHERE pr.token=$1 AND pr.expires_at > NOW()',
      [token]
    );
  },

  async deleteUser(userId) { await run('DELETE FROM password_resets WHERE user_id=$1', [userId]); },
  async deleteToken(token) { await run('DELETE FROM password_resets WHERE token=$1', [token]); }
};

// ===== COMPONENT STATUSES =====
module.exports.componentStatuses = {
  async list() { return await queryAll('SELECT * FROM component_statuses ORDER BY position, value'); },
  async get(value) { return await queryOne('SELECT * FROM component_statuses WHERE value=$1', [value]); },

  async create({ value, label, color, position, is_system }) {
    const id = uuidv4();
    await run('INSERT INTO component_statuses (id,value,label,color,position,is_system) VALUES ($1,$2,$3,$4,$5,$6)', [id, value, label, color||'#10b981', position||0, is_system ? 1 : 0]);
    return await this.get(value);
  },

  async update(value, data) {
    const fields = [];
    const params = [];
    const allowed = ['label','color','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(value);
      await run('UPDATE component_statuses SET ' + fields.join(',') + ' WHERE value=$' + (params.length), ...params);
    }
    return await this.get(value);
  },

  async delete(value) {
    const s = await this.get(value);
    if (s && s.is_system) return false;
    await run('DELETE FROM component_statuses WHERE value=$1', [value]);
    return true;
  }
};

// ===== INCIDENT STATUSES =====
module.exports.incidentStatuses = {
  async list() { return await queryAll('SELECT * FROM incident_statuses ORDER BY position, value'); },
  async get(value) { return await queryOne('SELECT * FROM incident_statuses WHERE value=$1', [value]); },

  async create({ value, label, color, position, is_system }) {
    const id = uuidv4();
    await run('INSERT INTO incident_statuses (id,value,label,color,position,is_system) VALUES ($1,$2,$3,$4,$5,$6)', [id, value, label, color||'#10b981', position||0, is_system ? 1 : 0]);
    return await this.get(value);
  },

  async update(value, data) {
    const fields = [];
    const params = [];
    const allowed = ['label','color','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(value);
      await run('UPDATE incident_statuses SET ' + fields.join(',') + ' WHERE value=$' + (params.length), ...params);
    }
    return await this.get(value);
  },

  async delete(value) {
    const s = await this.get(value);
    if (s && s.is_system) return false;
    await run('DELETE FROM incident_statuses WHERE value=$1', [value]);
    return true;
  }
};

// ===== STATUS MAPPINGS =====
module.exports.statusMappings = {
  async list() {
    return await queryAll(
      'SELECT sm.*, i.label as incident_label, i.color as incident_color, cs.label as component_label, cs.color as component_color FROM status_mappings sm LEFT JOIN incident_statuses i ON sm.incident_status = i.value LEFT JOIN component_statuses cs ON sm.component_status = cs.value ORDER BY i.position, sm.incident_status'
    );
  },

  async get(incidentStatus, componentStatus) {
    return await queryOne('SELECT * FROM status_mappings WHERE incident_status=$1 AND component_status=$2', [incidentStatus, componentStatus]);
  },

  async getByIncident(incidentStatus) {
    return await queryAll('SELECT * FROM status_mappings WHERE incident_status=$1', [incidentStatus]);
  },

  async create({ incident_status, component_status }) {
    const id = uuidv4();
    await run('INSERT INTO status_mappings (id,incident_status,component_status) VALUES ($1,$2,$3)', [id, incident_status, component_status]);
    return await this.get(incident_status, component_status);
  },

  async update(incidentStatus, componentStatus, data) {
    const fields = [];
    const params = [];
    const allowed = ['component_status'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(incidentStatus, componentStatus);
      await run('UPDATE status_mappings SET ' + fields.join(',') + ' WHERE incident_status=$1 AND component_status=$2', ...params);
    }
    return await this.get(incidentStatus, componentStatus);
  },

  async delete(incidentStatus, componentStatus) {
    await run('DELETE FROM status_mappings WHERE incident_status=$1 AND component_status=$2', [incidentStatus, componentStatus]);
    return true;
  },

  async resolve(incidentStatus) {
    const row = await queryOne('SELECT component_status FROM status_mappings WHERE incident_status=$1', [incidentStatus]);
    return row ? row.component_status : null;
  }
};

// ===== COMPONENT GROUPS =====
module.exports.componentGroups = {
  async findByName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    return await queryOne('SELECT * FROM component_groups WHERE LOWER(name)=LOWER($1)', [trimmed]);
  },

  async findOrCreateByName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    let group = await this.findByName(trimmed);
    if (!group) {
      const pos = await queryOne('SELECT COALESCE(MAX(position), -1) + 1 as next FROM component_groups');
      group = await this.create({ name: trimmed, position: pos ? pos.next : 0 });
    }
    return group;
  },

  async list(pageId) {
    let q = 'SELECT * FROM component_groups WHERE 1=1';
    const p = [];
    if (pageId) { q += ' AND id IN (SELECT group_id FROM group_pages WHERE page_id=$' + (p.length + 1) + ')'; p.push(pageId); }
    q += ' ORDER BY position, name';
    return await queryAll(q, p);
  },

  async get(id) { return await queryOne('SELECT * FROM component_groups WHERE id=$1', [id]); },

  async getPages(id) {
    return await queryAll("SELECT p.* FROM pages p JOIN group_pages gp ON gp.page_id=p.id WHERE gp.group_id=$1", [id]);
  },

  async getPageIds(id) {
    return await queryAll("SELECT page_id FROM group_pages WHERE group_id=$1", [id]).then(rows => rows.map(r => r.page_id));
  },

  // Group ids assigned to a page (the inverse of getPageIds — used to pre-check
  // the "Groups shown on this page" checkboxes when editing a page).
  async getGroupIdsForPage(pageId) {
    return await queryAll("SELECT group_id FROM group_pages WHERE page_id=$1", [pageId]).then(rows => rows.map(r => r.group_id));
  },

  // Components that belong to this group (many-to-many).
  async getMembers(id) {
    return await queryAll(
      'SELECT c.* FROM components c JOIN component_group_members cgm ON cgm.component_id = c.id WHERE cgm.group_id=$1 ORDER BY c.position, c.name',
      [id]
    );
  },

  // Sync a group's member list (exact): add newly-selected components, remove
  // unselected ones. Other groups of each component are preserved; the legacy
  // primary group_id/group_name is kept or re-pointed when affected.
  async setMembers(groupId, componentIds) {
    let ids = [];
    if (Array.isArray(componentIds)) ids = componentIds.filter(Boolean);
    else if (typeof componentIds === 'string' && componentIds) ids = componentIds.split(',').map(s => s.trim()).filter(Boolean);
    const selected = [...new Set(ids)];
    const current = (await queryAll('SELECT component_id FROM component_group_members WHERE group_id=$1', [groupId])).map(r => r.component_id);
    const currentSet = new Set(current);
    const selectedSet = new Set(selected);
    const group = await this.get(groupId);
    const groupName = group ? group.name : null;

    for (const cid of selected.filter(id => !currentSet.has(id))) {
      const comp = await module.exports.components.get(cid);
      if (!comp) continue;
      await run('INSERT INTO component_group_members (component_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cid, groupId]);
      // Component had no group at all -> make this its primary (legacy compat)
      if (!comp.group_id) {
        await run('UPDATE components SET group_id=$1, group_name=$2 WHERE id=$3', [groupId, groupName, cid]);
      }
    }
    for (const cid of current.filter(id => !selectedSet.has(id))) {
      await run('DELETE FROM component_group_members WHERE component_id=$1 AND group_id=$2', [cid, groupId]);
      const comp = await module.exports.components.get(cid);
      if (comp && comp.group_id === groupId) {
        // It was the component's primary group: re-point to another membership or NULL
        const rest = await module.exports.components.getGroups(cid);
        if (rest.length) {
          await run('UPDATE components SET group_id=$1, group_name=$2 WHERE id=$3', [rest[0].id, rest[0].name, cid]);
        } else {
          await run('UPDATE components SET group_id=NULL, group_name=NULL WHERE id=$1', [cid]);
        }
      }
    }
    return this.getMembers(groupId);
  },

  async countComponents(id) {
    const result = await queryOne("SELECT COUNT(*) as c FROM component_group_members WHERE group_id=$1", [id]);
    return result.c;
  },

  async create({ name, page_ids, position }) {
    const id = uuidv4();
    await run('INSERT INTO component_groups (id, name, position) VALUES ($1,$2,$3)', [id, name, parseInt(position) || 0]);
    const pids = this._normalizeIds(page_ids);
    for (const pid of pids) {
      await run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid]);
    }
    return this.get(id);
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=$'+(params.length+1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE component_groups SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    if (data.page_ids !== undefined) {
      await run('DELETE FROM group_pages WHERE group_id=$1', [id]);
      const pids = this._normalizeIds(data.page_ids);
      for (const pid of pids) {
        await run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid]);
      }
    }
    return this.get(id);
  },

  // Accept array or comma-joined string of ids ('id1,id2'), deduped.
  _normalizeIds(value) {
    let ids = [];
    if (Array.isArray(value)) ids = value.filter(Boolean);
    else if (typeof value === 'string' && value) ids = value.split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set(ids)];
  },

  async delete(id) {
    await run("UPDATE components SET group_id=NULL WHERE group_id=$1", [id]);
    await run('DELETE FROM group_pages WHERE group_id=$1', [id]);
    await run('DELETE FROM component_groups WHERE id=$1', [id]);
    return true;
  }
};

// ===== USERS =====
module.exports.users = {
  async list() {
    return await queryAll('SELECT id, email, name, role, created_at, email_notifications, updated_at FROM users ORDER BY created_at');
  },

  async get(id) {
    return await queryOne('SELECT id, email, name, role, created_at, email_notifications, updated_at FROM users WHERE id=$1', [id]);
  },

  async getByEmail(email) {
    return await queryOne('SELECT * FROM users WHERE email=$1', [email]);
  },

  async listAdmins() {
    return await queryAll('SELECT id, email, name, role, email_notifications FROM users WHERE role=$1', ['admin']);
  },

  async create({ id, email, password_hash, name, role }) {
    await run(
      'INSERT INTO users (id, email, password_hash, name, role, totp_enabled, totp_secret) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, email, password_hash, name, role || 'user', 0, null]
    );
    return this.get(id);
  },

  async update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['email', 'name', 'role', 'email_notifications'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k + '=$' + (params.length + 1)); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      await run('UPDATE users SET ' + fields.join(', ') + ', updated_at=NOW() WHERE id=$' + (params.length), ...params);
    }
    return this.get(id);
  },

  async delete(id) { await run('DELETE FROM users WHERE id=$1', [id]); return true; }
};

// ===== AUDIT LOG =====
module.exports.auditLog = {
  async create({ user_id, action, target, details, ip, user_agent }) {
    const id = require('uuid').v4();
    await run('INSERT INTO audit_log (id, user_id, action, target, details, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, user_id, action, target||'', details||'', ip||'', user_agent||'']);
  },

  async list(limit) {
    limit = limit || 50;
    return await queryAll('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
  },

  async listByUser(userId, limit) {
    limit = limit || 50;
    return await queryAll('SELECT * FROM audit_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
  },

  async cleanOld(days) {
    await run("DELETE FROM audit_log WHERE created_at < NOW() - ($1::text || ' days')::interval", [days]);
  }
};
