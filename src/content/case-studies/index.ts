import type { CaseStudy } from "./types";
import { adClickAggregation } from "./ad-click-aggregation";
import { chat } from "./chat";
import { distributedCache } from "./distributed-cache";
import { dropbox } from "./dropbox";
import { googleDocs } from "./google-docs";
import { hotelBooking } from "./hotel-booking";
import { instagram } from "./instagram";
import { jobScheduler } from "./job-scheduler";
import { keyValueStore } from "./key-value-store";
import { leaderboard } from "./leaderboard";
import { metricsMonitoring } from "./metrics-monitoring";
import { newsFeed } from "./news-feed";
import { notificationSystem } from "./notification-system";
import { pastebin } from "./pastebin";
import { paymentSystem } from "./payment-system";
import { proximityService } from "./proximity-service";
import { rateLimiter } from "./rate-limiter";
import { searchEngine } from "./search-engine";
import { stockExchange } from "./stock-exchange";
import { ticketBooking } from "./ticket-booking";
import { twitterTimeline } from "./twitter-timeline";
import { typeahead } from "./typeahead";
import { uber } from "./uber";
import { urlShortener } from "./url-shortener";
import { webCrawler } from "./web-crawler";
import { youtube } from "./youtube";

export type * from "./types";
export { RUBRIC_STAGES } from "./types";

/** Track 5 case studies in curriculum order. Append new ones here (see README.md). */
export const caseStudies: CaseStudy[] = [
  urlShortener,
  pastebin,
  rateLimiter,
  keyValueStore,
  distributedCache,
  newsFeed,
  chat,
  notificationSystem,
  twitterTimeline,
  instagram,
  youtube,
  uber,
  proximityService,
  webCrawler,
  typeahead,
  searchEngine,
  googleDocs,
  dropbox,
  paymentSystem,
  ticketBooking,
  hotelBooking,
  leaderboard,
  adClickAggregation,
  metricsMonitoring,
  jobScheduler,
  stockExchange,
];

export const getCaseStudy = (id: string) => caseStudies.find((c) => c.id === id);
