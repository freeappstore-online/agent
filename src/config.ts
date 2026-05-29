/** Store configuration — one codebase, multiple deployments. */

export interface StoreConfig {
  store: "apps" | "games";
  org: string;
  domain: string;
  noun: string;
  Noun: string;
  nounPlural: string;
  storeRepo: string;
  storeName: string;
  agentName: string;
  accentColor: string;
  categories: string;
  auditParam: string;
  /** R2 bucket the host Worker serves from. The scaffold's deploy.yml
   *  syncs web/dist → r2://<r2Bucket>/<nounPlural>/<repo>/. */
  r2Bucket: string;
}

const CONFIGS: Record<string, StoreConfig> = {
  apps: {
    store: "apps",
    org: "freeappstore-online",
    domain: "freeappstore.online",
    noun: "app",
    Noun: "App",
    nounPlural: "apps",
    storeRepo: "freeappstore",
    storeName: "FreeAppStore",
    agentName: "freeappstore-agent",
    accentColor: "#2563eb",
    categories: "utilities, productivity, learning, lifestyle, finance, health, creative, social",
    auditParam: "app",
    r2Bucket: "fas-apps",
  },
  games: {
    store: "games",
    org: "freegamestore-online",
    domain: "freegamestore.online",
    noun: "game",
    Noun: "Game",
    nounPlural: "games",
    storeRepo: "freegamestore",
    storeName: "FreeGameStore",
    agentName: "freegamestore-agent",
    accentColor: "#10b981",
    categories: "arcade, puzzle, strategy, racing, sports, cards, board, rpg, action, casual",
    auditParam: "game",
    r2Bucket: "fgs-games",
  },
};

export function getConfig(store: string): StoreConfig {
  return CONFIGS[store] || CONFIGS.apps;
}
