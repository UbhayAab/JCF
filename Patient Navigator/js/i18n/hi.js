// ============================================================
// Hindi patient-facing strings. Devanagari.
//
// Written to sound like the Hindi spoken in the corridor outside the Tata
// Memorial OPD, not like a translated form. The specific choices, so the
// next person keeps them:
//
//   VERBS ARE GENDER NEUTRAL FOR THE SENDER. Hindi verbs agree with the
//   speaker's gender, and this message goes out over a shared organisation
//   number that could be Prachi or Ubhay. So it says "hum dhoondhenge", not
//   "main dhoondhungi". Every first-person line was checked for this.
//
//   THE FAMILY IS ADDRESSED AS "aap", and imperatives are the warm polite
//   form: kijiye, rakhiye, poochhiye. Not "karo", which is rude to an elder,
//   and not "karein", which reads like a government circular.
//
//   ENGLISH WORDS STAY WHERE THE HOSPITAL USES ENGLISH WORDS. A patient at
//   TMH says report, form, OPD, case paper, phone, website, estimate,
//   passbook, Aadhaar card, ration card. Replacing those with pure Hindi
//   coinages, "chikitsa prativedan" for report, would make the message less
//   readable, not more Hindi. Where a term has a real Hindi form the family
//   also uses, the Hindi comes first and the English follows in brackets
//   once: "aay pramaan patra (income certificate)".
//
//   DIGITS ARE LATIN. Rupee amounts, phone numbers, dates and times are read
//   off a bill, a bus and a prescription in Latin digits every day.
//   Devanagari numerals would be the one line that stops a reader cold.
//
//   PROPER NOUNS ARE NOT TRANSLATED. Organisation names, addresses and
//   phone numbers come out of the directory exactly as written, because
//   that is what is on the building and on the form the family will be
//   handed. The single exception is the hospital's own name, which every
//   patient here already reads and says in Devanagari.
//
//   Plain hyphen only, never an em dash or en dash. The Devanagari full
//   stop is the danda, and that is not a dash.
// ============================================================

export const HI = {

  // ---- header ----
  'msg.greeting':          'नमस्ते {name} जी। मैं {poc}, जरूरत केयर से।',
  'msg.greeting_no_poc':   'नमस्ते {name} जी। जरूरत केयर से।',
  'msg.greeting_no_name':  'नमस्ते। मैं {poc}, जरूरत केयर से।',

  'msg.intro.accommodation_one':   'अस्पताल के पास रहने के लिए यह 1 जगह आपके काम आ सकती है।',
  'msg.intro.accommodation_other': 'अस्पताल के पास रहने के लिए ये {count} जगहें आपके काम आ सकती हैं।',
  'msg.intro.financial_aid_one':   'इलाज के खर्च में यह 1 जगह आपकी मदद कर सकती है।',
  'msg.intro.financial_aid_other': 'इलाज के खर्च में ये {count} जगहें आपकी मदद कर सकती हैं।',
  'msg.intro.mixed_one':           'यह 1 जगह आपकी मदद कर सकती है।',
  'msg.intro.mixed_other':         'ये {count} जगहें आपकी मदद कर सकती हैं।',

  // ---- the five slots ----
  'block.what':   'क्या मिलेगा',
  'block.who':    'किसके लिए',
  'block.bring':  'ये कागज़ साथ ले जाएँ',
  'block.do':     'क्या करना है',
  'block.phone':  'फ़ोन',

  // ---- slot 1 ----
  'what.room_free':        'अस्पताल के पास रहने की जगह। कोई पैसा नहीं लगेगा।',
  'what.room_free_at':     '{area} में रहने की जगह। कोई पैसा नहीं लगेगा।',
  'what.room_price':       '{area} में कमरा। एक रात का {price}।',
  'what.room_range':       '{area} में कमरा। एक रात का {min} से {max}।',
  'what.room_from':        '{area} में कमरा। एक रात का किराया {price} से शुरू।',
  'what.room':             '{area} में कमरा।',
  'what.grant':            'इलाज के खर्च में पैसों की मदद।',
  'what.govt_scheme':      'सरकारी योजना, जिसमें इलाज का कुछ खर्च सरकार उठाती है।',
  'what.hospital_fund':    'अस्पताल का अपना फंड, उन मरीज़ों के लिए जो बिल नहीं भर पाते।',
  'what.crowdfunding':     'एक वेबसाइट, जो आपके इलाज के लिए लोगों से पैसे इकट्ठा करती है।',
  'what.medicines':        'दवाइयाँ मुफ़्त या कम दाम पर।',
  'what.travel':           'अस्पताल आने और जाने के किराए में मदद।',
  'what.equipment':        'व्हीलचेयर या अस्पताल वाला बेड जैसी चीज़ें उधार पर।',
  'what.insurance':        'हेल्थ इंश्योरेंस का क्लेम कराने में मदद।',
  'what.help':             'इलाज में मदद।',

  // ---- slot 2 ----
  'who.any_age':           'किसी भी उम्र के मरीज़ के लिए।',
  'who.up_to_age':         '{age} साल तक की उम्र के मरीज़ों के लिए।',
  'who.from_age':          '{age} साल या उससे ज़्यादा उम्र के मरीज़ों के लिए।',
  'who.age_between':       '{min} से {max} साल की उम्र के मरीज़ों के लिए।',
  'who.women':             'महिला मरीज़ों के लिए।',
  'who.men':               'पुरुष मरीज़ों के लिए।',
  'who.attendant_one':     'मरीज़ के साथ घर का 1 व्यक्ति रह सकता है।',
  'who.attendant_other':   'मरीज़ के साथ घर के {count} लोग तक रह सकते हैं।',
  'who.attendant_any':     'मरीज़ के साथ घर का एक व्यक्ति भी रह सकता है।',
  'who.in_city':           '{city} में इलाज के लिए आने वाले परिवारों के लिए।',

  // ---- slot 3 ----
  'bring.nothing_listed':  'उन्होंने यह नहीं बताया कि क्या लाना है। आधार कार्ड और अस्पताल का केस पेपर साथ रखिए, काम आएगा।',
  'bring.also_helpful':    'अगर आपके पास हों तो ये भी साथ रखिए: {items}।',

  'doc.aadhaar':               'आधार कार्ड',
  'doc.ration_card':           'राशन कार्ड',
  'doc.bpl_card':              'बीपीएल कार्ड (पीला राशन कार्ड)',
  'doc.income_certificate':    'आय प्रमाण पत्र (income certificate)',
  'doc.domicile':              'निवास प्रमाण पत्र (domicile)',
  'doc.caste_certificate':     'जाति प्रमाण पत्र',
  'doc.disability_certificate':'दिव्यांग प्रमाण पत्र',
  'doc.abha':                  'आभा हेल्थ कार्ड (ABHA)',
  'doc.pan':                   'पैन कार्ड',
  'doc.bank_account':          'बैंक पासबुक',
  'doc.scheme_enrolment':      'आयुष्मान कार्ड या अपने राज्य की योजना का कार्ड',
  'doc.hospital_case_paper':   'अस्पताल का केस पेपर',
  'doc.doctor_letter':         'डॉक्टर का लिखा हुआ पत्र',
  'doc.medical_reports':       'आपकी रिपोर्ट',
  'doc.cost_estimate':         'अस्पताल से मिला खर्च का एस्टिमेट',
  'doc.referral_letter':       'अस्पताल के सोशल वर्कर (MSW) से रेफरल लेटर',
  'doc.address_proof':         'पते का सबूत, जैसे बिजली का बिल',
  'doc.passport_photo':        'दो पासपोर्ट साइज़ फोटो',
  'doc.photo_id':              'कोई भी फोटो वाला पहचान पत्र',

  // ---- slot 4 ----
  'do.call':               'नीचे दिए नंबर पर फ़ोन कीजिए और बताइए कि आप {hospital} के मरीज़ हैं।',
  'do.call_hours':         'नीचे दिए नंबर पर {from} से {to} के बीच फ़ोन कीजिए और बताइए कि आप {hospital} के मरीज़ हैं।',
  'do.call_ask_for':       'फ़ोन पर {name} से बात कीजिए।',
  'do.visit':              'खुद वहाँ जाइए और रिसेप्शन पर पूछिए।',
  'do.call_then_visit':    'पहले फ़ोन कीजिए, फिर खुद वहाँ जाइए।',
  'do.apply_online':       'इस वेबसाइट पर आवेदन कीजिए: {link}',
  'do.address':            'पता: {address}',

  // ---- slot 5 ----
  'expect.free_rooms_fill_up':   'कमरे बहुत कम हैं और जल्दी भर जाते हैं। जाने से पहले फ़ोन ज़रूर कर लीजिए।',
  'expect.never_phoned_by_us':   'हमने खुद अभी उनसे बात नहीं की है। अगर कोई फ़ोन न उठाए तो हमें बताइए, हम कोशिश करेंगे।',
  'expect.not_checked_in_a_year':'एक साल से ज़्यादा हो गया है, दोबारा पता नहीं किया गया। पहले फ़ोन कर लीजिए।',
  'expect.waiting_list':         'अभी वेटिंग लिस्ट चल रही है।',
  'expect.must_go_in_person':    'यह काम फ़ोन पर नहीं होता। किसी को खुद वहाँ जाना पड़ेगा।',
  'expect.phone_never_answered': 'ये लोग अक्सर फ़ोन नहीं उठाते। खुद जाकर मिलना ज़्यादा काम आता है।',
  'expect.phone_hard_to_reach':  'फ़ोन हमेशा नहीं उठता। दो या तीन बार कोशिश कीजिए।',
  'expect.takes_days':           'इसमें आमतौर पर {days} दिन लग जाते हैं।',
  'expect.missing_document':     'ये लोग यह माँगेंगे: {doc}। आपने बताया था कि वह आपके पास नहीं है। जाने से पहले मुझे फ़ोन कीजिए, हम रास्ता निकालेंगे।',
  'expect.papers_unknown':       'निकलने से पहले फ़ोन पर पूछ लीजिए कि कौन कौन से कागज़ चाहिए।',
  'expect.checked_on':           '{date} को हमने उनसे पूछा था, तब जगह थी।',
  'expect.no_phone_number':      'इनका फ़ोन नंबर हमारे पास नहीं है, सिर्फ़ पता है।',

  // ---- footer ----
  'msg.more_available_one':   'हमारी सूची में 1 जगह और है। अगर यह काम न आए तो बताइए, हम वह भी भेज देंगे।',
  'msg.more_available_other': 'हमारी सूची में और भी जगहें हैं। अगर इनमें से कोई काम न आए तो बताइए, हम आगे की जगहें भेज देंगे।',
  'msg.closing':              'अगर कोई मना कर दे तो मुझे {phone} पर फ़ोन कीजिए, हम दूसरी जगह ढूँढेंगे।',
  'msg.closing_no_phone':     'अगर कोई मना कर दे तो हमें बताइए, हम दूसरी जगह ढूँढेंगे।',
  'msg.signoff':              '{poc}, जरूरत केयर',
  'msg.signoff_no_poc':       'जरूरत केयर',

  // ---- the one proper noun that is translated ----
  'place.tata_memorial':   'टाटा मेमोरियल अस्पताल',
  // City names only. A patient reading Hindi reads "मुंबई", not "Mumbai".
  // Street names, building names and organisation names are NOT in this list
  // and are never touched, because a half transliterated address is worse
  // than an English one when it has to be shown to a rickshaw driver.
  'xlit.Mumbai': 'मुंबई', 'xlit.Navi': 'नवी', 'xlit.Delhi': 'दिल्ली',
  'xlit.Thane': 'ठाणे', 'xlit.Pune': 'पुणे', 'xlit.Hyderabad': 'हैदराबाद',
  'xlit.Chennai': 'चेन्नई', 'xlit.Kolkata': 'कोलकाता', 'xlit.Nagpur': 'नागपुर',
  'place.default_hospital':'टाटा मेमोरियल अस्पताल',

  // ---- formatting ----
  'fmt.rupees':            '{n} रुपये',
  'fmt.clock':             '{part} {h}{mm} बजे',
  'fmt.daypart.morning':   'सुबह',
  'fmt.daypart.afternoon': 'दोपहर',
  'fmt.daypart.evening':   'शाम',
  'fmt.daypart.night':     'रात',
  'fmt.date':              '{d} {month}',
  'fmt.list_sep':          ', ',
  'fmt.list_last':         ' और ',
  'month.1': 'जनवरी', 'month.2': 'फ़रवरी', 'month.3': 'मार्च',   'month.4': 'अप्रैल',
  'month.5': 'मई',    'month.6': 'जून',    'month.7': 'जुलाई',   'month.8': 'अगस्त',
  'month.9': 'सितंबर','month.10': 'अक्टूबर','month.11': 'नवंबर', 'month.12': 'दिसंबर',
};
