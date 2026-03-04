/**
 * Industry Taxonomy
 *
 * Each industry has two arrays:
 *  - `triggers`: words/phrases a user might type that should resolve to this industry
 *  - `keywords`: terms used to search Yahoo Finance for stocks in this industry
 *
 * This separation means searching "insurance" correctly maps to the "finance" industry
 * and then searches all finance keywords on Yahoo Finance.
 */
export const INDUSTRY_TAXONOMY: Record<string, {
  triggers: string[];
  keywords: string[];
  screenerHint?: string;
}> = {
  technology: {
    triggers: [
      "tech", "technology", "software", "hardware", "computer", "ai", "artificial intelligence",
      "machine learning", "ml", "deep learning", "saas", "cloud", "devops", "cybersecurity",
      "semiconductor", "chip", "electronics", "developer", "programming", "coding", "startup",
      "platform", "app", "mobile", "web", "algorithm", "database", "infrastructure", "digital",
      "network", "IT", "information technology", "automation", "data", "big data", "iot",
      "internet of things", "quantum", "blockchain", "open source", "api", "microservices"
    ],
    keywords: [
      "tech stocks", "software companies", "cloud computing", "semiconductor stocks",
      "AI stocks", "cybersecurity stocks", "SaaS companies", "hardware companies",
      "internet companies", "data analytics stocks"
    ],
    screenerHint: "growth_technology_stocks"
  },

  healthcare: {
    triggers: [
      "health", "healthcare", "medical", "hospital", "clinic", "doctor", "nurse", "patient",
      "pharmacy", "pharmaceutical", "pharma", "biotech", "biotechnology", "surgery", "therapy",
      "diagnosis", "wellness", "mental health", "dentist", "pediatric", "oncology", "radiology",
      "telehealth", "laboratory", "lab", "clinical", "drug", "medicine", "vaccine", "genomics",
      "medtech", "life sciences", "diagnostics", "nursing", "physician", "treatment", "FDA"
    ],
    keywords: [
      "healthcare stocks", "pharmaceutical companies", "biotech stocks", "medical device companies",
      "hospital stocks", "drug companies", "life sciences stocks", "telehealth stocks",
      "genomics stocks", "health insurance stocks"
    ]
  },

  finance: {
    triggers: [
      "finance", "financial", "banking", "bank", "investment", "investing", "accounting",
      "insurance", "insurer", "fintech", "trading", "wealth", "mortgage", "loan", "credit",
      "equity", "hedge fund", "hedge", "audit", "tax", "budget", "portfolio", "asset",
      "capital", "revenue", "stock market", "bond", "crypto", "cryptocurrency", "wallet",
      "payment", "payments", "compliance", "risk", "brokerage", "broker", "lender", "lending",
      "underwriting", "actuarial", "annuity", "pension", "fund", "ETF", "mutual fund",
      "private equity", "venture capital", "VC", "IPO", "securities", "derivatives", "forex",
      "money", "monetary", "liquidity", "yield", "interest rate", "Fed", "central bank"
    ],
    keywords: [
      "banking stocks", "investment banks", "insurance companies", "fintech stocks",
      "asset management firms", "credit card companies", "mortgage companies",
      "brokerage firms", "payment processing stocks", "hedge funds"
    ]
  },

  education: {
    triggers: [
      "education", "school", "university", "college", "teaching", "learning", "curriculum",
      "student", "professor", "academic", "edtech", "tutoring", "training", "certification",
      "degree", "campus", "online learning", "k-12", "literacy", "stem", "scholarship",
      "admissions", "classroom", "elearning", "e-learning", "mooc", "course", "instruction",
      "pedagogy", "higher education", "vocational", "trade school"
    ],
    keywords: [
      "education stocks", "edtech companies", "online learning stocks", "university stocks",
      "tutoring companies", "e-learning stocks", "vocational training stocks"
    ]
  },

  retail: {
    triggers: [
      "retail", "store", "ecommerce", "e-commerce", "shopping", "merchandise", "inventory",
      "wholesale", "consumer", "brand", "product", "sales", "checkout", "customer",
      "marketplace", "fashion", "clothing", "apparel", "grocery", "discount", "loyalty",
      "fulfillment", "distribution", "point of sale", "catalog", "DTC", "direct to consumer",
      "luxury goods", "department store", "supermarket", "subscription box", "dropshipping"
    ],
    keywords: [
      "retail stocks", "ecommerce stocks", "consumer goods companies", "fashion stocks",
      "grocery stocks", "luxury goods companies", "department store stocks",
      "marketplace companies", "DTC brands", "wholesale companies"
    ]
  },

  real_estate: {
    triggers: [
      "real estate", "property", "housing", "mortgage", "agent", "broker", "lease", "rent",
      "rental", "commercial real estate", "residential", "development", "construction",
      "appraisal", "landlord", "tenant", "listing", "closing", "escrow", "zoning",
      "HOA", "condo", "apartment", "land", "renovation", "flip", "REIT", "proptech",
      "homebuilder", "property management", "multifamily", "office space", "retail space"
    ],
    keywords: [
      "REIT stocks", "real estate stocks", "homebuilder stocks", "property companies",
      "real estate investment trusts", "commercial real estate stocks",
      "residential real estate companies", "proptech stocks"
    ]
  },

  manufacturing: {
    triggers: [
      "manufacturing", "factory", "production", "assembly", "supply chain", "logistics",
      "quality control", "machining", "robotics", "plant", "operations", "fabrication",
      "materials", "lean", "six sigma", "ISO", "warehouse", "procurement", "equipment",
      "industrial", "steel", "chemical", "plastics", "textiles", "automotive parts",
      "aerospace parts", "3D printing", "additive manufacturing", "CNC", "OEM"
    ],
    keywords: [
      "manufacturing stocks", "industrial companies", "robotics stocks", "steel companies",
      "chemical companies", "automotive manufacturing stocks", "aerospace manufacturing stocks",
      "3D printing stocks", "industrial equipment stocks"
    ]
  },

  hospitality: {
    triggers: [
      "hospitality", "hotel", "restaurant", "travel", "tourism", "lodging", "resort",
      "catering", "chef", "cuisine", "guest", "reservation", "booking", "airline",
      "cruise", "event", "banquet", "concierge", "housekeeping", "spa", "bar",
      "food service", "venue", "vacation", "Airbnb", "short term rental", "motel",
      "theme park", "attraction", "food and beverage", "F&B", "quick service", "fast food"
    ],
    keywords: [
      "hotel stocks", "airline stocks", "cruise stocks", "restaurant stocks",
      "travel stocks", "resort stocks", "tourism companies", "food service stocks",
      "theme park stocks", "short term rental stocks"
    ]
  },

  media_and_entertainment: {
    triggers: [
      "media", "entertainment", "film", "movie", "music", "television", "TV", "streaming",
      "publishing", "journalism", "advertising", "marketing", "content", "social media",
      "podcast", "gaming", "video game", "animation", "production", "broadcast", "news",
      "radio", "influencer", "PR", "creative", "studio", "artist", "director", "writer",
      "editor", "OTT", "digital media", "esports", "sports media", "record label"
    ],
    keywords: [
      "streaming stocks", "gaming stocks", "media companies", "entertainment stocks",
      "advertising stocks", "social media stocks", "music stocks", "publishing companies",
      "esports stocks", "broadcast companies"
    ]
  },

  agriculture: {
    triggers: [
      "agriculture", "farming", "farm", "crop", "livestock", "harvest", "irrigation",
      "agtech", "soil", "organic", "seed", "fertilizer", "rural", "food production",
      "dairy", "poultry", "aquaculture", "forestry", "agribusiness", "sustainability",
      "greenhouse", "pesticide", "yield", "plantation", "ranching", "cattle", "grain",
      "corn", "wheat", "soybean", "food supply", "precision agriculture"
    ],
    keywords: [
      "agriculture stocks", "farming companies", "agtech stocks", "fertilizer companies",
      "seed companies", "livestock companies", "food production stocks",
      "precision agriculture stocks", "forestry stocks"
    ]
  },

  energy: {
    triggers: [
      "energy", "oil", "gas", "oil and gas", "renewable", "solar", "wind", "nuclear",
      "electric", "grid", "utility", "utilities", "petroleum", "coal", "battery",
      "power plant", "carbon", "emissions", "drilling", "pipeline", "refinery",
      "green energy", "clean energy", "hydropower", "geothermal", "biofuel",
      "energy storage", "transmission", "LNG", "fracking", "upstream", "downstream",
      "midstream", "EV charging", "hydrogen", "fuel cell", "decarbonization"
    ],
    keywords: [
      "oil and gas stocks", "renewable energy stocks", "solar stocks", "wind energy stocks",
      "utility stocks", "nuclear energy stocks", "battery storage stocks",
      "clean energy stocks", "pipeline companies", "hydrogen stocks"
    ]
  },

  transportation_and_logistics: {
    triggers: [
      "transportation", "logistics", "shipping", "freight", "trucking", "airline",
      "rail", "supply chain", "delivery", "fleet", "driver", "cargo", "port",
      "customs", "route", "last mile", "3PL", "courier", "dispatch", "transit",
      "import", "export", "container", "autonomous vehicles", "self-driving",
      "ride sharing", "rideshare", "Uber", "Lyft", "gig economy", "drone delivery",
      "ocean freight", "air freight", "intermodal"
    ],
    keywords: [
      "logistics stocks", "trucking stocks", "shipping stocks", "airline stocks",
      "freight companies", "supply chain stocks", "delivery companies",
      "rail stocks", "autonomous vehicle stocks", "rideshare stocks"
    ]
  },

  legal: {
    triggers: [
      "legal", "law", "attorney", "lawyer", "court", "litigation", "compliance",
      "contract", "regulation", "intellectual property", "IP", "corporate law",
      "paralegal", "judge", "firm", "law firm", "counsel", "mediation", "arbitration",
      "criminal", "civil", "patent", "trademark", "copyright", "tax law",
      "immigration", "real estate law", "defense", "legaltech", "legal tech"
    ],
    keywords: [
      "legal services stocks", "legaltech companies", "compliance stocks",
      "law firm stocks", "intellectual property companies"
    ]
  },

  gold: {
    triggers: [
      "gold", "gold mining", "gold stocks", "gold ETF", "bullion", "gold bullion",
      "precious metals", "gold futures", "gold price", "gold investment",
      "gold producer", "gold miner", "junior gold", "senior gold", "royalty gold",
      "streaming gold", "gold royalty", "gold exploration", "gold reserves",
      "safe haven", "store of value", "spot gold", "gold bar", "gold coin",
      "XAU", "GLD", "IAU", "gold fund", "gold trust"
    ],
    keywords: [
      "gold mining stocks", "gold producer companies", "precious metals stocks",
      "gold royalty companies", "gold streaming stocks", "junior gold miners",
      "gold ETF holdings", "gold exploration stocks"
    ]
  },

  government_and_public_sector: {
    triggers: [
      "government", "government contractor", "public sector", "policy", "federal",
      "state", "municipal", "defense", "military", "nonprofit", "agency", "regulation",
      "administration", "legislation", "civil service", "public safety", "social services",
      "infrastructure", "grant", "election", "diplomacy", "city planning", "GovTech",
      "defense contractor", "aerospace defense", "intelligence", "homeland security"
    ],
    keywords: [
      "defense stocks", "government contractor stocks", "aerospace defense companies",
      "public sector technology stocks", "homeland security stocks",
      "military technology stocks", "intelligence companies"
    ]
  },

  construction: {
    triggers: [
      "construction", "building", "contractor", "architecture", "engineering",
      "blueprint", "project management", "site", "permit", "HVAC", "plumbing",
      "electrical", "concrete", "steel", "carpentry", "renovation", "demolition",
      "commercial construction", "residential construction", "subcontractor",
      "inspection", "safety", "zoning", "materials", "crane", "infrastructure",
      "civil engineering", "structural engineering", "green building", "LEED"
    ],
    keywords: [
      "construction stocks", "homebuilder stocks", "building materials stocks",
      "infrastructure stocks", "engineering companies", "HVAC stocks",
      "architecture firms", "civil engineering stocks"
    ]
  },

  cybersecurity: {
    triggers: [
      "cybersecurity", "cyber security", "security", "network security", "cloud security",
      "threat intelligence", "data security", "information security", "infosec",
      "zero trust", "firewall", "endpoint security", "SIEM", "SOC", "vulnerability",
      "penetration testing", "pentest", "ransomware", "malware", "phishing",
      "identity management", "IAM", "privileged access", "encryption", "CISO",
      "compliance security", "DLP", "XDR", "MDR", "zero day"
    ],
    keywords: [
      "cybersecurity stocks", "network security companies", "cloud security stocks",
      "endpoint security stocks", "identity management stocks", "threat intelligence companies",
      "zero trust security stocks", "SIEM companies", "managed security stocks"
    ]
  }
};

/**
 * Resolves a user's search term to an industry using exact word boundary matching only.
 * e.g. "insurance" → "finance", "solar" → "energy", "ransomware" → "cybersecurity"
 * Will NOT match partial words — "solar" will not match "solarium".
 */
export function categorizeByTaxonomy(text: string): string | null {
  if (!text) return null;
  const normalizedText = text.toLowerCase().trim();

  let bestMatch: string | null = null;
  let maxScore = 0;

  for (const [industry, { triggers }] of Object.entries(INDUSTRY_TAXONOMY)) {
    let score = 0;

    for (const trigger of triggers) {
      const escapedTrigger = trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedTrigger}\\b`, 'gi');
      const matches = normalizedText.match(regex);
      if (matches) {
        score += matches.length;
      }
    }

    if (score > maxScore) {
      maxScore = score;
      bestMatch = industry;
    }
  }

  return maxScore > 0 ? bestMatch : null;
}

/**
 * Returns the Yahoo Finance search keywords for a given industry.
 * These are what get sent to yahooFinance.search().
 */
export function getCategoryKeywords(category: string): string[] {
  return INDUSTRY_TAXONOMY[category]?.keywords || [];
}

/**
 * Returns strategy info for a category including optional screener ID and display title.
 */
export function getCategoryStrategy(category: string): {
  screenerId?: string;
  title: string;
} {
  const titleMap: Record<string, string> = {
    technology: 'Technology',
    healthcare: 'Healthcare',
    finance: 'Finance',
    education: 'Education',
    retail: 'Retail',
    real_estate: 'Real Estate',
    manufacturing: 'Manufacturing',
    hospitality: 'Hospitality & Travel',
    media_and_entertainment: 'Media & Entertainment',
    agriculture: 'Agriculture',
    energy: 'Energy',
    transportation_and_logistics: 'Transportation & Logistics',
    legal: 'Legal',
    government_and_public_sector: 'Government & Defense',
    construction: 'Construction',
    cybersecurity: 'Cybersecurity',
  };

  const screenerMap: Record<string, string> = {
    technology: 'growth_technology_stocks',
  };

  return {
    title: titleMap[category] ?? category.replace(/_/g, ' '),
    screenerId: screenerMap[category],
  };
}