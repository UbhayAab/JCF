// ============================================================
// English patient-facing strings.
//
// This is the reference catalogue: every other language is judged against
// these keys, and a key missing here is a bug, not a translation gap.
//
// Written for someone holding a diagnosis, on a basic phone, in a corridor.
// Rules that were applied to every line and should be applied to the next
// one:
//   - one idea per sentence, and short sentences
//   - no NGO words. No "beneficiary", "avail", "disbursed", "modality"
//   - no abbreviations the family has not already met at the hospital
//   - say the hard thing. "The rooms are usually full" belongs in the
//     message, not in the disappointment afterwards
//   - never a staff note, never an internal code, never a database word
//   - plain hyphen only, never an em dash or en dash, anywhere
// ============================================================

export const EN = {

  // ---- header ----
  'msg.greeting':          'Namaste {name} ji. This is {poc} from Jarurat Care.',
  'msg.greeting_no_poc':   'Namaste {name} ji. This is Jarurat Care.',
  'msg.greeting_no_name':  'Namaste. This is {poc} from Jarurat Care.',

  'msg.intro.accommodation_one':   'Here is 1 place that can help you stay near the hospital.',
  'msg.intro.accommodation_other': 'Here are {count} places that can help you stay near the hospital.',
  'msg.intro.financial_aid_one':   'Here is 1 place that can help with the cost of treatment.',
  'msg.intro.financial_aid_other': 'Here are {count} places that can help with the cost of treatment.',
  'msg.intro.mixed_one':           'Here is 1 place that can help you.',
  'msg.intro.mixed_other':         'Here are {count} places that can help you.',

  // ---- the five slots, every block, every time ----
  'block.what':   'What you get',
  'block.who':    'Who it is for',
  'block.bring':  'Papers to carry',
  'block.do':     'What to do',
  'block.phone':  'Phone',

  // ---- slot 1: what they GET, never the organisation's mission ----
  'what.room_free':        'A place to stay near the hospital. No charge.',
  'what.room_free_at':     'A place to stay in {area}. No charge.',
  'what.room_price':       'A room in {area}. {price} for one night.',
  'what.room_range':       'A room in {area}. {min} to {max} for one night.',
  'what.room_from':        'A room in {area}. From {price} a night.',
  'what.room':             'A room in {area}.',
  'what.grant':            'Money towards the cost of your treatment.',
  'what.govt_scheme':      'A government scheme that pays for part of your treatment.',
  'what.hospital_fund':    'The hospital fund for patients who cannot pay the bill.',
  'what.crowdfunding':     'A website that collects money from the public for your treatment.',
  'what.medicines':        'Medicines free of charge or at a lower price.',
  'what.travel':           'Help with the fare to and from the hospital.',
  'what.equipment':        'Equipment on loan, such as a wheelchair or a hospital bed.',
  'what.insurance':        'Help with a health insurance claim.',
  'what.help':             'Help with your treatment.',

  // ---- slot 2: who it is for ----
  'who.any_age':           'Any age.',
  'who.up_to_age':         'Patients up to {age} years old.',
  'who.from_age':          'Patients {age} years and older.',
  'who.age_between':       'Patients between {min} and {max} years old.',
  'who.women':             'Women patients.',
  'who.men':               'Men patients.',
  'who.attendant_one':     'The patient and 1 family member.',
  'who.attendant_other':   'The patient and up to {count} family members.',
  'who.attendant_any':     'A family member can stay with the patient.',
  'who.in_city':           'Families coming to {city} for treatment.',

  // ---- slot 3: papers ----
  'bring.nothing_listed':  'They have not told us what to bring. Carry your Aadhaar card and your hospital case paper to be safe.',
  'bring.also_helpful':    'If you have them, also carry: {items}.',

  'doc.aadhaar':               'Aadhaar card',
  'doc.ration_card':           'Ration card',
  'doc.bpl_card':              'BPL card (the yellow ration card)',
  'doc.income_certificate':    'Income certificate',
  'doc.domicile':              'Domicile certificate',
  'doc.caste_certificate':     'Caste certificate',
  'doc.disability_certificate':'Disability certificate',
  'doc.abha':                  'ABHA health card',
  'doc.pan':                   'PAN card',
  'doc.bank_account':          'Bank passbook',
  'doc.scheme_enrolment':      'Ayushman card or your state scheme card',
  'doc.hospital_case_paper':   'Hospital case paper',
  'doc.doctor_letter':         'Letter from your doctor',
  'doc.medical_reports':       'Your reports',
  'doc.cost_estimate':         'Cost estimate from the hospital',
  'doc.referral_letter':       'Referral letter from the hospital social worker',
  'doc.address_proof':         'Address proof',
  'doc.passport_photo':        'Two passport size photos',
  'doc.photo_id':              'Any photo ID',

  // ---- slot 4: one concrete action ----
  'do.call':               'Call the number below and say you are a patient at {hospital}.',
  'do.call_hours':         'Call the number below between {from} and {to} and say you are a patient at {hospital}.',
  'do.call_ask_for':       'Ask for {name}.',
  'do.visit':              'Go there yourself and ask at the front desk.',
  'do.call_then_visit':    'Call first, then go there yourself.',
  'do.apply_online':       'Apply on this website: {link}',
  'do.address':            'Address: {address}',

  // ---- slot 5: what to expect, said plainly ----
  'expect.free_rooms_fill_up':   'There are only a few rooms and they fill up fast. Phone before you go.',
  'expect.never_phoned_by_us':   'We have not spoken to them ourselves yet. If nobody answers, tell us and we will try.',
  'expect.not_checked_in_a_year':'It has been more than a year since anyone confirmed this. Phone first.',
  'expect.waiting_list':         'There is a waiting list at the moment.',
  'expect.must_go_in_person':    'They will not do this over the phone. Someone has to go there.',
  'expect.phone_never_answered': 'They usually do not pick up the phone. Going there in person works better.',
  'expect.phone_hard_to_reach':  'The phone is not always answered. Try two or three times.',
  'expect.takes_days':           'This usually takes about {days} days.',
  'expect.missing_document':     'They will ask for this: {doc}. You told us you do not have one, so call me before you go and we will work it out.',
  'expect.papers_unknown':       'Ask on the phone what papers they want before you travel.',
  'expect.checked_on':           'We asked them on {date} and they had space.',
  'expect.no_phone_number':      'We do not have a phone number for them, only the address.',

  // ---- footer ----
  'msg.more_available_one':   'There is 1 more place on our list. If this one does not work out, tell me and I will send it.',
  // No number on purpose: the matcher is asked for a page of results, not a
  // census, so a precise count here would be precisely wrong.
  'msg.more_available_other': 'We have more places on our list. If none of these work out, tell me and we will send the next ones.',
  'msg.closing':              'If any of them turn you away, call me on {phone} and we will find another one.',
  'msg.closing_no_phone':     'If any of them turn you away, tell us and we will find another one.',
  'msg.signoff':              '{poc}, Jarurat Care',
  'msg.signoff_no_poc':       'Jarurat Care',

  // ---- proper nouns we do translate, and only these ----
  // Everything else, organisation names, addresses, phone numbers, is passed
  // through exactly as it is written in the directory, because that is what
  // is painted on the building and printed on the form.
  'place.tata_memorial':   'Tata Memorial Hospital',
  // Place-name tokens. Only whole tokens with an entry here are ever
  // substituted, so an address can never be mangled by a partial match. The
  // English catalogue leaves them as they are; this list exists so the Hindi
  // one has something to override.
  'xlit.Mumbai': 'Mumbai', 'xlit.Navi': 'Navi', 'xlit.Delhi': 'Delhi',
  'xlit.Thane': 'Thane', 'xlit.Pune': 'Pune', 'xlit.Hyderabad': 'Hyderabad',
  'xlit.Chennai': 'Chennai', 'xlit.Kolkata': 'Kolkata', 'xlit.Nagpur': 'Nagpur',
  'place.default_hospital':'Tata Memorial Hospital',

  // ---- formatting ----
  'fmt.rupees':            'Rs {n}',
  'fmt.clock':             '{h}{mm} {part}',
  'fmt.daypart.morning':   'am',
  'fmt.daypart.afternoon': 'pm',
  'fmt.daypart.evening':   'pm',
  'fmt.daypart.night':     'pm',
  'fmt.date':              '{d} {month}',
  'fmt.list_sep':          ', ',
  'fmt.list_last':         ' and ',
  'month.1': 'Jan', 'month.2': 'Feb', 'month.3': 'Mar', 'month.4': 'Apr',
  'month.5': 'May', 'month.6': 'Jun', 'month.7': 'Jul', 'month.8': 'Aug',
  'month.9': 'Sep', 'month.10': 'Oct', 'month.11': 'Nov', 'month.12': 'Dec',
};
