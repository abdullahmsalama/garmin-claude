// Garmin Connect Personal API: every URL and limit in one place.
// Source: developer.garmin.com/gc-developer-program/personal/ (Personal API page + Swagger spec, Oct 2026).

export const GARMIN = {
  base: 'https://personal.connectapi.garmin.com',
  // POST with header "Authorization: ApiKey <key>" -> access token, valid 24 h (no refresh tokens).
  tokenPath: '/personalapitoken-service/personal-api/personal-api-key/token',
  paths: {
    activities: '/activitylist-service/activities/search/activities', // ?startDate&endDate&start&limit (max 99 per page)
    activity: id => `/activity-service/activity/${id}`,
    activityWorkouts: id => `/activity-service/activity/${id}/workouts`,
    dailies: '/usersummary-service/v2/dailysummaries', // ?startDate&endDate, up to 1 year
    sleep: '/sleep-service/sleep/dailySleepSummariesByDate', // ?startDate&endDate, up to 31 days
    hrv: (from, to) => `/hrv-service/hrv/daily/${from}/${to}`,
    bodyBattery: '/wellness-service/wellness/bodyBattery/reports/daily', // ?startDate&endDate, up to 31 days
    weight: (from, to) => `/weight-service/weight/all/${from}/${to}`,
    weightRange: (from, to) => `/weight-service/weight/range/${from}/${to}`,
    hrZones: '/biometric-service/heartRateZones/v2',
    fitnessAge: date => `/fitnessage-service/fitnessage/v2/${date}`,
    settings: '/userprofile-service/userprofile/settings',
    // Inside an activity: the original file (zip with a .fit) and Garmin's chart data (not in the docs, but answers).
    download: id => `/download-service/files/activity/${id}`,
    details: id => `/activity-service/activity/${id}/details`, // ?maxChartSize&maxPolylineSize
    // One day in detail.
    dailyHeartRate: '/wellness-service/wellness/dailyHeartRate', // ?date: all-day HR, ~2 min
    hrvDay: date => `/hrv-service/hrv/${date}`, // overnight readings, every 5 min
    sleepDay: '/sleep-service/sleep/dailySleep', // ?date
    userSummary: '/usersummary-service/usersummary/daily', // ?calendarDate
    spo2: date => `/wellness-service/wellness/daily/spo2acclimation/${date}`,
    weightGoals: (from, to) => `/goal-service/goal/user/effective/weightgoal/${from}/${to}`,
  },
  // Days per request when loading history (Garmin's documented maximums, or a safe size where none is given).
  chunkDays: { activities: 31, dailies: 120, sleep: 31, hrv: 31, bodyBattery: 31, weight: 120 },
};
