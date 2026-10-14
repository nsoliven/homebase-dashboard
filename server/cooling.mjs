// Qualitative heuristics, not an acoustic measurement or a fan-control policy.
export function coolingStatus(readings = [], profile = {}) {
  const channels = Array.isArray(profile.channels) ? profile.channels : [];
  const fans = readings.map(f => {
    const p = channels.find(c => c.id === f.id);
    return {...f, name: typeof p?.name === 'string' ? p.name.slice(0, 100) : f.name,
      role: ['fan', 'pump'].includes(p?.role) ? p.role : 'unassigned',
      confirmed: p?.confirmed === true,
      maxRpm: Number.isFinite(p?.maxRpm) && p.maxRpm > 0 && p.maxRpm <= 20000 ? p.maxRpm : null};
  });
  const candidates = fans.filter(f => f.role === 'fan' && Number.isFinite(f.rpm) && f.rpm > 0 && f.maxRpm);
  const lead = candidates.sort((a,b) => b.rpm/b.maxRpm-a.rpm/a.maxRpm)[0];
  let noise = {level: null, label: 'Sound estimate unavailable', description: 'A fan reading and a rated-speed reference are needed.', basis: 'No microphone measurement.'};
  if (lead) {
    const fraction = lead.rpm/lead.maxRpm;
    const level = fraction < .35 ? 1 : fraction < .55 ? 2 : fraction < .8 ? 3 : 4;
    const descriptions = ['Likely a soft background hum.', 'Likely gentle, steady air movement.', 'Likely noticeable airflow nearby.', 'Likely a strong fan whoosh nearby.'];
    const confirmed = candidates.every(f => f.confirmed);
    noise = {level, label: ['Quiet','Light airflow','Audible airflow','Strong airflow'][level-1],
      description: descriptions[level-1], rpm: lead.rpm, referenceRpm: lead.maxRpm,
      confirmed, basis: `${lead.name} relative to its ${lead.maxRpm.toLocaleString()} RPM reference. ${confirmed ? 'Configured fan roles.' : 'Fan and pump roles are inferred.'} No microphone measurement; distance, case, and fan model affect actual sound.`};
  }
  return {fans, noise, description: typeof profile.description === 'string' ? profile.description.slice(0, 200) : '',
    observedAt: null};
}

export function thermalState(host = {}) {
  const value = host.cpuTemperature;
  // Model-specific published Tjmax. Do not apply this to X3D or other models.
  const limit = /\b(?:7900X|7950X|7700X|7600X)\b/i.test(host.cpuModel || '') ? 95 : null;
  if (!Number.isFinite(value)) return {label:'Temperature unavailable',tone:'neutral',alert:false,limit};
  if (limit) {
    if (value > limit+2) return {label:'Above rated temperature',tone:'warning',alert:true,limit};
    if (value >= limit-3 && Number.isFinite(host.cpu) && host.cpu < 10) return {label:'High temperature at light load',tone:'warning',alert:true,limit};
    if (value >= limit-3) return {label:'Near boost temperature limit',tone:'warning',alert:false,limit};
    return {label:'Below thermal limit',tone:'success',alert:false,limit};
  }
  return {label:value > 85 ? 'High temperature · limit unknown' : 'Temperature reporting',tone:value > 85 ? 'warning' : 'neutral',alert:value > 85,limit};
}
