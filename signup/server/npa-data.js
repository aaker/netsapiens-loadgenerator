// Static NANPA geographic area-code data for the US.
// Sourced from public NANPA assignments. Time zone is the dominant zone for
// split states (matches the "US/*" strings used in lib/randomdata.js).

const STATE_TZ = {
  AL: 'US/Central', AK: 'US/Alaska', AZ: 'US/Arizona', AR: 'US/Central',
  CA: 'US/Pacific', CO: 'US/Mountain', CT: 'US/Eastern', DE: 'US/Eastern',
  DC: 'US/Eastern', FL: 'US/Eastern', GA: 'US/Eastern', HI: 'US/Hawaii',
  ID: 'US/Mountain', IL: 'US/Central', IN: 'US/Eastern', IA: 'US/Central',
  KS: 'US/Central', KY: 'US/Eastern', LA: 'US/Central', ME: 'US/Eastern',
  MD: 'US/Eastern', MA: 'US/Eastern', MI: 'US/Eastern', MN: 'US/Central',
  MS: 'US/Central', MO: 'US/Central', MT: 'US/Mountain', NE: 'US/Central',
  NV: 'US/Pacific', NH: 'US/Eastern', NJ: 'US/Eastern', NM: 'US/Mountain',
  NY: 'US/Eastern', NC: 'US/Eastern', ND: 'US/Central', OH: 'US/Eastern',
  OK: 'US/Central', OR: 'US/Pacific', PA: 'US/Eastern', RI: 'US/Eastern',
  SC: 'US/Eastern', SD: 'US/Central', TN: 'US/Central', TX: 'US/Central',
  UT: 'US/Mountain', VT: 'US/Eastern', VA: 'US/Eastern', WA: 'US/Pacific',
  WV: 'US/Eastern', WI: 'US/Central', WY: 'US/Mountain'
};

const STATE_NPAS = {
  AL: ['205', '251', '256', '334', '659', '938'],
  AK: ['907'],
  AZ: ['480', '520', '602', '623', '928'],
  AR: ['479', '501', '870'],
  CA: ['209', '213', '279', '310', '323', '341', '350', '408', '415', '424',
       '442', '510', '530', '559', '562', '619', '626', '628', '650', '657',
       '661', '669', '707', '714', '747', '760', '805', '818', '820', '831',
       '840', '858', '909', '916', '925', '949', '951'],
  CO: ['303', '719', '720', '970', '983'],
  CT: ['203', '475', '860', '959'],
  DE: ['302'],
  DC: ['202', '771'],
  FL: ['239', '305', '321', '352', '386', '407', '448', '561', '656', '689',
       '727', '754', '772', '786', '813', '850', '863', '904', '941', '954'],
  GA: ['229', '404', '470', '478', '678', '706', '762', '770', '912', '943'],
  HI: ['808'],
  ID: ['208', '986'],
  IL: ['217', '224', '309', '312', '331', '447', '618', '630', '708', '773',
       '779', '815', '847', '872'],
  IN: ['219', '260', '317', '463', '574', '765', '812', '930'],
  IA: ['319', '515', '563', '641', '712'],
  KS: ['316', '620', '785', '913'],
  KY: ['270', '364', '502', '606', '859'],
  LA: ['225', '318', '337', '504', '985'],
  ME: ['207'],
  MD: ['240', '301', '410', '443', '667'],
  MA: ['339', '351', '413', '508', '617', '774', '781', '857', '978'],
  MI: ['231', '248', '269', '313', '517', '586', '616', '734', '810', '906',
       '947', '989'],
  MN: ['218', '320', '507', '612', '651', '763', '952'],
  MS: ['228', '601', '662', '769'],
  MO: ['314', '417', '557', '573', '636', '660', '816'],
  MT: ['406'],
  NE: ['308', '402', '531'],
  NV: ['702', '725', '775'],
  NH: ['603'],
  NJ: ['201', '551', '609', '640', '732', '848', '856', '862', '908', '973'],
  NM: ['505', '575'],
  NY: ['212', '315', '332', '347', '363', '516', '518', '585', '607', '631',
       '646', '680', '716', '718', '838', '845', '914', '917', '929', '934'],
  NC: ['252', '336', '704', '743', '828', '910', '919', '980', '984'],
  ND: ['701'],
  OH: ['216', '220', '234', '283', '326', '330', '380', '419', '440', '513',
       '567', '614', '740', '937'],
  OK: ['405', '539', '572', '580', '918'],
  OR: ['458', '503', '541', '971'],
  PA: ['215', '223', '267', '272', '412', '445', '484', '570', '610', '717',
       '724', '814', '878'],
  RI: ['401'],
  SC: ['803', '839', '843', '854', '864'],
  SD: ['605'],
  TN: ['423', '615', '629', '731', '865', '901', '931'],
  TX: ['210', '214', '254', '281', '325', '346', '361', '409', '430', '432',
       '469', '512', '682', '713', '726', '737', '806', '817', '830', '832',
       '903', '915', '936', '940', '945', '956', '972', '979'],
  UT: ['385', '435', '801'],
  VT: ['802'],
  VA: ['276', '434', '540', '571', '703', '757', '804', '826', '948'],
  WA: ['206', '253', '360', '425', '509', '564'],
  WV: ['304', '681'],
  WI: ['262', '414', '534', '608', '715', '920'],
  WY: ['307']
};

const NPA_STATE = {};
for (const [state, npas] of Object.entries(STATE_NPAS)) {
  for (const npa of npas) NPA_STATE[npa] = state;
}

function stateOf(npa) {
  return NPA_STATE[npa] || null;
}

function tzOf(npa) {
  const state = stateOf(npa);
  return state ? STATE_TZ[state] : 'US/Central';
}

function isValidNpa(npa) {
  return Object.prototype.hasOwnProperty.call(NPA_STATE, npa);
}

function npasOf(state) {
  return STATE_NPAS[state] || [];
}

module.exports = { stateOf, tzOf, isValidNpa, npasOf };
