// ─────────────────────────────────────────────────────
// Cancer Groups Data
// Updated with WhatsApp group links from OCR
// ─────────────────────────────────────────────────────
const CANCER_GROUPS = [
    {
        id: "esophagus-stomach",
        hi: "अन्नप्रणाली और पेट का कैंसर",
        mr: "अन्ननलिका आणि पोटाचा कर्करोग",
        en: "Esophagus & Stomach Cancers",
        subtypes_hi: ["अन्नप्रणाली कैंसर (EC)", "GEJ कैंसर (GEJ)", "पेट / गैस्ट्रिक कैंसर (GC)"],
        subtypes_en: ["Esophageal cancer (EC)", "Gastroesophageal junction (GEJ)", "Stomach / Gastric cancer (GC)"],
        subtypes_mr: ["अन्ननलिका कर्करोग (EC)", "GEJ कर्करोग (GEJ)", "पोटाचा कर्करोग (GC)"],
        url: "https://chat.whatsapp.com/J3P1zNxUmjrKvZ3oP8pdOW"
    },
    {
        id: "intestinal-colorectal",
        hi: "आंत और कोलोरेक्टल कैंसर",
        mr: "आतडे आणि कोलोरेक्टल कर्करोग",
        en: "Intestinal & Colorectal Cancers",
        subtypes_hi: [
            "कोलोरेक्टल कैंसर – कोलन और रेक्टल (CRC)",
            "छोटी आंत कैंसर (SBC)",
            "गुदा कैंसर (AC)",
            "अपेंडिक्स कैंसर (AppC)"
        ],
        subtypes_en: ["Colorectal cancer (CRC)", "Small bowel cancer (SBC)", "Anal cancer (AC)", "Appendiceal cancer (AppC)"],
        subtypes_mr: ["कोलोरेक्टल कर्करोग (CRC)", "लहान आतड्याचा कर्करोग (SBC)", "गुदद्वाराचा कर्करोग (AC)", "अपेंडिक्स कर्करोग (AppC)"],
        url: "https://chat.whatsapp.com/HHOkhrgQ4UzEHziP5QyPDC"
    },
    {
        id: "liver",
        hi: "लिवर (यकृत) का कैंसर",
        mr: "यकृताचा (लिव्हर) कर्करोग",
        en: "Liver Cancers",
        subtypes_hi: ["हेपैटोसेलुलर कार्सिनोमा (HCC)", "हेपैटोब्लास्टोमा (HB)"],
        subtypes_en: ["Hepatocellular carcinoma (HCC)", "Hepatoblastoma (HB)"],
        subtypes_mr: ["हेपॅटोसेल्युलर कार्सिनोमा (HCC)", "हेपॅटोब्लास्टोमा (HB)"],
        url: "https://chat.whatsapp.com/Drprw3LEzfGHWri73hpGOD"
    },
    {
        id: "gallbladder-bile-duct",
        hi: "पित्ताशय और पित्त नली का कैंसर",
        mr: "पित्ताशय आणि पित्तनलिकेचा कर्करोग",
        en: "Gallbladder & Bile Duct Cancers",
        subtypes_hi: ["पित्ताशय कैंसर (GBC)", "पित्त नली / बाइलरी ट्रैक्ट कैंसर (BTC / CCA)"],
        subtypes_en: ["Gallbladder cancer (GBC)", "Biliary tract / Bile duct cancer (BTC)"],
        subtypes_mr: ["पित्ताशय कर्करोग (GBC)", "पित्त नलिका कर्करोग (BTC)"],
        url: "https://chat.whatsapp.com/BC90sQCX5YWK0KMpNI9m0w"
    },
    {
        id: "pancreatic-ampullary",
        hi: "अग्नाशय और एम्पुलरी कैंसर",
        mr: "स्वादुपिंड आणि एम्पुलरी कर्करोग",
        en: "Pancreatic & Ampullary Cancers",
        subtypes_hi: [
            "अग्नाशय कैंसर (PC / PDAC)",
            "एम्पुलरी कैंसर (AmpC)",
            "अग्नाशयी न्यूरोएंडोक्राइन ट्यूमर (pNETs)"
        ],
        subtypes_en: ["Pancreatic cancer (PDAC)", "Ampullary cancer (AmpC)", "Pancreatic neuroendocrine tumors (pNETs)"],
        subtypes_mr: ["स्वादुपिंड कर्करोग (PDAC)", "एम्पुलरी कर्करोग (AmpC)", "स्वादुपिंड न्यूरोएंडोक्राइन ट्यूमर (pNETs)"],
        url: "https://chat.whatsapp.com/HUqWtzKfjbpCesAc9AhYrk"
    },
    {
        id: "rare-special-gi",
        hi: "दुर्लभ और विशेष GI ट्यूमर",
        mr: "दुर्मिळ आणि विशेष GI गाठी",
        en: "Rare & Special GI Tumors",
        subtypes_hi: [
            "गैस्ट्रोइंटेस्टिनल स्ट्रोमल ट्यूमर (GIST)",
            "GI न्यूरोएंडोक्राइन ट्यूमर (GI NETs)",
            "प्राथमिक पेरिटोनियल कैंसर (PPC)",
            "GI लिम्फोमा (GI-Lymphoma)"
        ],
        subtypes_en: ["Gastrointestinal stromal tumors (GIST)", "GI neuroendocrine tumors (GI NETs)", "Primary peritoneal cancer (PPC)", "GI lymphomas"],
        subtypes_mr: ["गॅस्ट्रोइंटेस्टाइनल स्ट्रोमल ट्यूमर (GIST)", "GI न्यूरोएंडोक्राइन ट्यूमर (GI NETs)", "प्राथमिक पेरिटोनियल कर्करोग (PPC)", "GI लिम्फोमा"],
        url: "https://chat.whatsapp.com/KQrCBidbIe2KuZ3fKTDoWq"
    }
];

// ─────────────────────────────────────────────
// Language Selection Logic
// ─────────────────────────────────────────────
let currentLang = 'en';

function setLanguage(lang) {
    currentLang = lang;
    document.documentElement.lang = lang;
    
    // Hide overlay
    document.getElementById('langOverlay').style.display = 'none';
    
    // Show main app and apply language class to show correct strings
    const appContainer = document.getElementById('appContainer');
    appContainer.className = `container app-${lang}`;
    appContainer.style.display = 'block';

    // Set document title dynamically
    if (lang === 'hi') {
        document.title = "ज़रूरत केयर फाउंडेशन – HOPE सर्कल";
    } else if (lang === 'mr') {
        document.title = "जरुरत केअर फाउंडेशन – HOPE सर्कल";
    } else {
        document.title = "Jarurat Care Foundation – HOPE Circle";
    }
}

// ─────────────────────────────────────────────
// Render Options
// ─────────────────────────────────────────────
const container = document.getElementById('optionsContainer');
const joinBtn = document.getElementById('joinBtn');
let selectedUrl = null;

function renderOptions() {
    container.innerHTML = ''; // Clear

    CANCER_GROUPS.forEach((g) => {
        // Prepare chips markup
        const chipsEn = g.subtypes_en.map(s => `<span>${s}</span>`).join('');
        const chipsHi = g.subtypes_hi.map(s => `<span>${s}</span>`).join('');
        const chipsMr = g.subtypes_mr.map(s => `<span>${s}</span>`).join('');

        const card = document.createElement('label');
        card.className = 'option-card';
        card.innerHTML = `
            <input type="radio" name="cancer" value="${g.id}" data-url="${g.url}">
            <div class="option-label">
                <div class="radio-dot"></div>
                <div class="option-text">
                    <!-- Title shown based on lang rules -->
                    <div class="opt-title lang-en">${g.en}</div>
                    <div class="opt-title lang-hi">${g.hi}</div>
                    <div class="opt-title lang-mr">${g.mr}</div>

                    <!-- Subtypes shown based on lang rules -->
                    <div class="opt-subtypes lang-en">${chipsEn}</div>
                    <div class="opt-subtypes lang-hi">${chipsHi}</div>
                    <div class="opt-subtypes lang-mr">${chipsMr}</div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// First render
renderOptions();

// ─────────────────────────────────────────────
// Selection & Redirect
// ─────────────────────────────────────────────
container.addEventListener('change', (e) => {
    if (e.target.name === 'cancer') {
        selectedUrl = e.target.dataset.url;
        joinBtn.disabled = false;
    }
});

function redirectToGroup() {
    if (selectedUrl) {
        window.location.href = selectedUrl;
    }
}

// ─────────────────────────────────────────────
// Social Native App Deep Linking
// ─────────────────────────────────────────────
function openApp(app) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(navigator.userAgent);
    
    let appUrl = '';
    let webUrl = '';
    let intentUrl = '';

    if (app === 'ig') {
        webUrl = "https://www.instagram.com/jarurat.care";
        appUrl = "instagram://user?username=jarurat.care";
        intentUrl = "intent://instagram.com/jarurat.care#Intent;package=com.instagram.android;scheme=https;end";
    } else if (app === 'yt') {
        webUrl = "https://youtube.com/@jaruratcare?sub_confirmation=1";
        appUrl = "youtube://www.youtube.com/@jaruratcare"; // iOS YouTube deep link
        intentUrl = "intent://youtube.com/@jaruratcare?sub_confirmation=1#Intent;package=com.google.android.youtube;scheme=https;end";
    }

    if (isAndroid && intentUrl) {
        // Android handles Intents natively and falls back automatically
        window.location.href = intentUrl;
    } else if (isIOS && appUrl) {
        // iOS requires a timeout fallback to web if app isn't installed
        setTimeout(() => {
            window.location.href = webUrl;
        }, 1500);
        window.location.href = appUrl;
    } else {
        // Desktop or other platforms
        window.open(webUrl, '_blank');
    }
}
