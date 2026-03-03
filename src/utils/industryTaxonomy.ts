export const INDUSTRY_TAXONOMY = {
  "industries": {
    "technology": [
      "tech", "computer", "software", "hardware", "ai", "engineer", "developer",
      "programming", "coding", "cloud", "data", "cybersecurity", "network", "IT",
      "machine learning", "automation", "digital", "startup", "saas", "platform",
      "app", "mobile", "web", "devops", "algorithm", "database", "infrastructure",
      "semiconductor", "electronics"
    ],
    "healthcare": [
      "medical", "health", "hospital", "clinic", "doctor", "nurse", "patient",
      "pharmacy", "pharmaceutical", "biotech", "surgery", "therapy", "diagnosis",
      "wellness", "mental health", "dentist", "pediatric", "oncology", "radiology",
      "insurance", "telehealth", "laboratory", "research", "clinical"
    ],
    "finance": [
      "banking", "investment", "accounting", "insurance", "fintech", "trading",
      "wealth", "mortgage", "loan", "credit", "equity", "hedge fund", "audit",
      "tax", "budget", "portfolio", "asset", "capital", "revenue", "financial",
      "stock", "bond", "crypto", "wallet", "payment", "compliance", "risk"
    ],
    "education": [
      "school", "university", "college", "teaching", "learning", "curriculum",
      "student", "professor", "academic", "edtech", "tutoring", "training",
      "certification", "degree", "research", "campus", "online learning", "k-12",
      "literacy", "stem", "scholarship", "admissions", "classroom", "elearning"
    ],
    "retail": [
      "store", "ecommerce", "shopping", "merchandise", "inventory", "supply chain",
      "wholesale", "consumer", "brand", "product", "sales", "checkout", "customer",
      "marketplace", "fashion", "clothing", "grocery", "discount", "loyalty",
      "fulfillment", "distribution", "retail", "point of sale", "catalog"
    ],
    "real_estate": [
      "property", "housing", "mortgage", "agent", "broker", "lease", "rent",
      "commercial", "residential", "development", "construction", "appraisal",
      "investment", "landlord", "tenant", "listing", "closing", "escrow", "zoning",
      "HOA", "condo", "apartment", "land", "renovation", "flip"
    ],
    "manufacturing": [
      "factory", "production", "assembly", "supply chain", "logistics", "quality control",
      "engineering", "machining", "automation", "robotics", "plant", "operations",
      "fabrication", "materials", "inventory", "lean", "six sigma", "ISO", "warehouse",
      "distribution", "procurement", "equipment", "industrial", "steel", "chemical"
    ],
    "hospitality": [
      "hotel", "restaurant", "travel", "tourism", "lodging", "resort", "catering",
      "chef", "cuisine", "guest", "reservation", "booking", "airline", "cruise",
      "event", "banquet", "concierge", "housekeeping", "front desk", "spa", "bar",
      "hospitality", "food service", "venue", "vacation"
    ],
    "media_and_entertainment": [
      "film", "music", "television", "streaming", "publishing", "journalism",
      "advertising", "marketing", "content", "social media", "podcast", "gaming",
      "animation", "production", "broadcast", "news", "radio", "influencer", "PR",
      "creative", "studio", "artist", "director", "writer", "editor"
    ],
    "agriculture": [
      "farming", "crop", "livestock", "harvest", "irrigation", "agtech", "soil",
      "organic", "seed", "fertilizer", "equipment", "rural", "food production",
      "dairy", "poultry", "aquaculture", "forestry", "agribusiness", "sustainability",
      "greenhouse", "pesticide", "yield", "plantation", "ranching"
    ],
    "energy": [
      "oil", "gas", "renewable", "solar", "wind", "nuclear", "electric", "grid",
      "utility", "petroleum", "coal", "battery", "power plant", "sustainability",
      "carbon", "emissions", "drilling", "pipeline", "refinery", "green energy",
      "hydropower", "geothermal", "biofuel", "energy storage", "transmission"
    ],
    "transportation_and_logistics": [
      "shipping", "freight", "trucking", "airline", "rail", "supply chain", "warehouse",
      "delivery", "fleet", "driver", "cargo", "port", "customs", "route", "last mile",
      "3PL", "courier", "dispatch", "logistics", "transit", "import", "export",
      "container", "fulfillment", "autonomous vehicles"
    ],
    "legal": [
      "law", "attorney", "lawyer", "court", "litigation", "compliance", "contract",
      "regulation", "intellectual property", "corporate law", "paralegal", "judge",
      "firm", "counsel", "mediation", "arbitration", "criminal", "civil", "patent",
      "trademark", "tax law", "immigration", "real estate law", "defense"
    ],
    "government_and_public_sector": [
      "government", "policy", "public", "federal", "state", "municipal", "defense",
      "military", "nonprofit", "agency", "regulation", "administration", "legislation",
      "civil service", "public safety", "social services", "infrastructure", "grant",
      "election", "diplomacy", "tax", "budget", "city planning"
    ],
    "construction": [
      "building", "contractor", "architecture", "engineering", "blueprint",
      "project management", "site", "permit", "HVAC", "plumbing", "electrical",
      "concrete", "steel", "carpentry", "renovation", "demolition", "commercial",
      "residential", "subcontractor", "inspection", "safety", "zoning", "materials", "crane"
    ], 
    "Cybersecurity": [
      "Networking",
      "Network Security",
      "Cloud",
      "Cloud Security",
      "Cloud Computing",
      "Threat Intelligence",
      "Data Security"
    ]
  }
};

/**
 * Categorizes a string of text into one of the taxonomy buckets based on keyword density.
 */
export function categorizeByTaxonomy(text: string): string | null {
  if (!text) return null;
  const normalizedText = text.toLowerCase();
  
  let bestMatch = null;
  let maxScore = 0;

  for (const [industry, keywords] of Object.entries(INDUSTRY_TAXONOMY.industries)) {
    let score = 0;
    for (const keyword of keywords) {
      // Use regex for word boundary matching to avoid partial matches like "ai" in "mail"
      const regex = new RegExp(`\\b${keyword.toLowerCase()}\\b`, 'g');
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
 * Gets the full list of keywords for a category.
 */
export function getCategoryKeywords(category: string): string[] {
  return (INDUSTRY_TAXONOMY.industries as any)[category] || [];
}

/**
 * Maps our internal taxonomy categories to Yahoo Finance screener IDs or search hints.
 */
export function getCategoryStrategy(category: string): { 
  screenerId?: string; 
  searchHint?: string; 
  title: string;
  yahooSector?: string;
} {
  const strategies: Record<string, any> = {
    technology: { screenerId: 'growth_technology_stocks', title: 'Technology', yahooSector: 'Technology' },
    healthcare: { title: 'Healthcare', yahooSector: 'Healthcare' },
    finance: { title: 'Finance', yahooSector: 'Financial Services' },
    education: { searchHint: 'Education stocks', title: 'Education' },
    retail: { title: 'Retail', yahooSector: 'Consumer Cyclical' },
    real_estate: { title: 'Real Estate', yahooSector: 'Real Estate' },
    manufacturing: { title: 'Manufacturing', yahooSector: 'Industrials' },
    hospitality: { searchHint: 'Travel and Hospitality stocks', title: 'Hospitality' },
    media_and_entertainment: { title: 'Media & Entertainment', yahooSector: 'Communication Services' },
    agriculture: { searchHint: 'Agriculture stocks', title: 'Agriculture' },
    energy: { title: 'Energy', yahooSector: 'Energy' },
    transportation_and_logistics: { searchHint: 'Logistics stocks', title: 'Transportation' },
    legal: { searchHint: 'Legal services stocks', title: 'Legal' },
    government_and_public_sector: { searchHint: 'Government contractors stocks', title: 'Government' },
    construction: { searchHint: 'Construction stocks', title: 'Construction' },
  };

  return strategies[category] || { title: category.replace(/_/g, ' ') };
}
