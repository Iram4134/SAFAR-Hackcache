// Mirrors the constants in the SAFAR frontend so both sides agree.
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const SLOTS = [
  { id: "Morning", label: "Morning", time: "6am–12pm" },
  { id: "Afternoon", label: "Afternoon", time: "12–5pm" },
  { id: "Evening", label: "Evening", time: "5–9pm" },
];
export const SLOT_KEYS = DAYS.flatMap((d) => SLOTS.map((s) => `${d}-${s.id}`));
export const SKILLS = [
  "Photography", "Video Editing", "Event Support", "Customer Service", "Tour Guiding",
  "Cooking", "Driving", "Delivery", "Data Entry", "Tutoring", "Social Media",
  "Graphic Design", "Handicrafts", "Retail Sales", "Cashiering", "Spoken English",
];
export const TOWNS = [
  "Srinagar", "Ganderbal", "Budgam", "Gulmarg", "Baramulla",
  "Pahalgam", "Anantnag", "Jammu", "Udhampur", "Katra",
];
export const JOB_LOCATIONS = [...TOWNS, "Remote"];
export const REGION = {
  Srinagar: "K", Ganderbal: "K", Budgam: "K", Gulmarg: "K", Baramulla: "K",
  Pahalgam: "K", Anantnag: "K", Jammu: "J", Udhampur: "J", Katra: "J",
};
export const NEAR = [
  ["Srinagar", "Ganderbal"], ["Srinagar", "Budgam"], ["Gulmarg", "Baramulla"],
  ["Pahalgam", "Anantnag"], ["Jammu", "Udhampur"], ["Udhampur", "Katra"],
  ["Baramulla", "Srinagar"],
];
export const SECTORS = [
  "Events", "Tourism", "Hospitality", "Food & Beverage", "Retail",
  "Education", "Handicrafts", "Agriculture", "Media",
];
export const TYPES = ["Gig", "Part-time", "Seasonal"];
export const UNITS = ["day", "hour", "month", "project"];
export const STATUSES = ["Applied", "Shortlisted", "Interview", "Hired", "Rejected"];
