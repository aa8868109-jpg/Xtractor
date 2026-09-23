const { getFirestore } = require('../firebase');

function getParts(req) {
  const raw = req.query?.slug || req.params?.slug || '';
  return (Array.isArray(raw) ? raw : String(raw).split('/')).filter(Boolean).map(decodeURIComponent);
}

function toRecord(doc, collection = '') {
  const data = doc.data() || {};
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'qr_1') fields['1st QR'] = value;
    else if (key === 'qr_2') fields['2nd QR'] = value;
    else if (key === 'qr_3') fields['3rd QR'] = value;
    else if (key === 'Device_ip') fields['Device IP'] = value;
    else fields[key.replace(/_/g, ' ')] = value;
  }
  if (/^LEC_\d+$/i.test(collection) && !fields.Code) fields.Code = doc.id;
  return { id: doc.id, fields };
}

function toFirestore(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === '1st QR' || key === '1st_QR') result.qr_1 = value;
    else if (key === '2nd QR' || key === '2nd_QR') result.qr_2 = value;
    else if (key === '3rd QR' || key === '3rd_QR') result.qr_3 = value;
    else if (key === 'Device IP' || key === 'Device_IP') result.Device_ip = value;
    else result[key.replace(/\s+/g, '_')] = value;
  }
  return result;
}

module.exports = async function handler(req, res) {
  try {
    const firestore = getFirestore();
    const parts = getParts(req);
    if (parts.length < 1) return res.status(400).json({ error: 'invalid_data_path' });
    const collection = parts[0];
    const documentId = parts[1] || null;
    const method = (req.method || 'GET').toUpperCase();

    if (collection === 'Protection') {
      const snap = await firestore.collection('System_Control').doc('Xtractor Website Protection').get();
      if (!snap.exists) return res.status(404).json({ error: 'protection_not_found' });
      const data = snap.data();
      return res.json({ records: [{ id: snap.id, fields: { Select: data.Website_Status ? 'Unlock' : 'Lock', Text: data.Text || '', Link: data.Link || '', Password: data.Dr_Pass || '' } }] });
    }

    if (collection === 'MODE') {
      const ref = firestore.collection('MODE').doc('Website Status');
      if (method === 'GET') {
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'mode_not_found' });
        const data = snap.data();
        return res.json({ records: [{ id: snap.id, fields: { 'Student Mode': data.Student_Mode === true ? 'ON' : 'OFF', Lecture: data.Lecture || null, 'QR Selected': data.QR_Selected || 'NONE', Name: data.Name || 'Website Status' } }] });
      }
      const fields = req.body?.fields || req.body || {};
      const updates = {};
      if (fields['Student Mode'] !== undefined) updates.Student_Mode = fields['Student Mode'] === 'ON' || fields['Student Mode'] === true;
      if (fields.Lecture !== undefined) updates.Lecture = fields.Lecture;
      if (fields['QR Selected'] !== undefined) updates.QR_Selected = fields['QR Selected'] || 'NONE';
      if (fields.Name !== undefined) updates.Name = fields.Name;
      await ref.set(updates, { merge: true });
      const snap = await ref.get();
      const data = snap.data();
      return res.json({ records: [{ id: snap.id, fields: { 'Student Mode': data.Student_Mode === true ? 'ON' : 'OFF', Lecture: data.Lecture || null, 'QR Selected': data.QR_Selected || 'NONE', Name: data.Name || 'Website Status' } }] });
    }

    if (!/^LEC_\d+$/i.test(collection)) return res.status(404).json({ error: 'collection_not_found' });
    const ref = firestore.collection(collection);
    const params = new URL(req.url || '/', 'http://localhost').searchParams;
    const formula = params.get('filterByFormula') || '';
    const match = formula.match(/^\{([^}]+)\}='([^']*)'$/) || formula.match(/^\(\{([^}]+)\}='([^']*)'\)$/);

    if (method === 'GET') {
      if (match && match[1] === 'Code') {
        const snap = await ref.doc(match[2]).get();
        return res.json({ records: snap.exists ? [toRecord(snap, collection)] : [] });
      }
      if (match && match[1] === 'Device IP') {
        const snaps = await ref.where('Device_ip', '==', match[2]).get();
        return res.json({ records: snaps.docs.map(doc => toRecord(doc, collection)) });
      }
      const snaps = await ref.get();
      return res.json({ records: snaps.docs.map(doc => toRecord(doc, collection)) });
    }

    if (method === 'PATCH' || method === 'PUT') {
      if (!documentId) return res.status(400).json({ error: 'missing_document_id' });
      await ref.doc(documentId).set(toFirestore(req.body?.fields || req.body || {}), { merge: true });
      return res.json(toRecord(await ref.doc(documentId).get(), collection));
    }

    if (method === 'POST') {
      const records = req.body?.records || [req.body || {}];
      const created = [];
      for (const item of records) {
        const fields = item.fields || item;
        const id = String(fields.Code || Math.random().toString(36).slice(2, 10));
        await ref.doc(id).set(toFirestore(fields), { merge: true });
        created.push(toRecord(await ref.doc(id).get(), collection));
      }
      return res.json({ records: created });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (error) {
    console.error('Data handler error:', error.message || error);
    return res.status(500).json({ error: 'data_handler_error', message: error.message || String(error) });
  }
};
