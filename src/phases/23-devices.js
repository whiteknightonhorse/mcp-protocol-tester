/**
 * Phase 23 — Device-connect T1 layer (Э3). Not tied to one of the six named
 * defects — added because the device-connect surface (/connect/device/*,
 * device.list/state/command) is real, deployed prod surface with zero
 * coverage in this tester before Э3, matching the audit's general "coverage
 * parity" theme.
 *
 * Requires a real connected sandbox device (DEVICE_TEST_API_KEY, an agent
 * with at least one live DeviceConnection) — SKIPs cleanly without one.
 * As of this pass no vendor is live-verified yet (Tuya OAuth is built but
 * blocked on the operator provisioning a Tuya IoT Cloud Project — see
 * apibase's own docs/OPERATOR-ACTION-device-vendor-tuya.md), so this phase
 * is expected to SKIP today, not fail — that is the honest state, not a
 * gap in this tester.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P23';

module.exports = async function phase23(scorer, config, context) {
  console.log('\n--- Phase 23: Devices ---');

  if (!config.deviceTestKey) {
    scorer.skip(PHASE, 'no DEVICE_TEST_API_KEY configured — needs an agent with a real connected ' +
      'sandbox device (operator-provisioned vendor account; T1/Tuya is not yet live-verified ' +
      'per apibase docs/OPERATOR-ACTION-device-vendor-tuya.md)');
    return;
  }

  const AUTH = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deviceTestKey}` };

  // Public connect-webview routes should be reachable regardless of whether
  // any device is actually connected — this part needs no sacrificial key,
  // but is grouped here since it is the same surface.
  for (const path of ['/connect/device/vendors', `/connect/device/${config.deviceTestVendor}/connections`]) {
    try {
      const r = await sf(`${config.apiBaseUrl}${path}`, { headers: config.deviceTestKey ? AUTH : {} });
      await drain(r);
      scorer.rec(PHASE, `23.1 ${path}`, '200', String(r.status), r.status === 200);
    } catch (e) {
      scorer.recCatch(PHASE, `23.1 ${path}`, '200', e);
    }
  }

  let listBody = null;
  try {
    const rList = await sf(`${config.apiUrl}/tools/device.list/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ vendor: config.deviceTestVendor }),
    });
    if (rList.status === 200) { try { listBody = await rList.json(); } catch { await drain(rList); } }
    else await drain(rList);
    scorer.rec(PHASE, '23.2 device.list', '200', String(rList.status), rList.status === 200);
  } catch (e) {
    scorer.recCatch(PHASE, '23.2 device.list', '200', e);
  }

  const devices = listBody?.data?.devices || listBody?.devices || [];
  if (devices.length === 0) {
    scorer.skip(PHASE, 'DEVICE_TEST_API_KEY has zero connected devices — cannot exercise state/command/safety-gate checks');
    return;
  }
  const deviceId = devices[0].id || devices[0].device_id;

  try {
    const rState = await sf(`${config.apiUrl}/tools/device.state/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ device_id: deviceId }),
    });
    await drain(rState);
    scorer.rec(PHASE, '23.3 device.state', '200', String(rState.status), rState.status === 200);
  } catch (e) {
    scorer.recCatch(PHASE, '23.3 device.state', '200', e);
  }

  // 23.4 — safety gate: a command outside the configured numeric bounds
  // must be rejected fail-closed (422), never forwarded to the vendor.
  try {
    const rBad = await sf(`${config.apiUrl}/tools/device.command/call`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ device_id: deviceId, command: 'set_temperature', value: 999999 }),
    });
    await drain(rBad);
    // RED: a safety-gate bypass on a physical device is a real-world harm
    // class, not a cosmetic API defect.
    scorer.redRec(PHASE, '23.4 safety gate rejects out-of-bounds command', '422', String(rBad.status),
      rBad.status === 422, rBad.status === 422 ? 'fail-closed as designed' : 'CRITICAL: out-of-bounds command was not rejected');
  } catch (e) {
    scorer.recCatch(PHASE, '23.4 safety gate rejects out-of-bounds command', '422', e);
  }

  console.log(`  Devices: vendor=${config.deviceTestVendor} devices=${devices.length}`);
};
