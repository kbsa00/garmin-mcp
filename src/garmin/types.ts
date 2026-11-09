// Raw Garmin Personal API response shapes (subset), from the Personal API OpenAPI spec.
// Every field is optional/nullable: Garmin omits or nulls fields freely.

export type Maybe<T> = T | null | undefined;

export interface SleepScoreItem {
	value?: Maybe<number>;
	qualifierKey?: Maybe<string>;
}

export interface DailySleepDTO {
	calendarDate?: Maybe<string>;
	sleepTimeSeconds?: Maybe<number>;
	napTimeSeconds?: Maybe<number>;
	sleepStartTimestampGMT?: Maybe<number | string>;
	sleepEndTimestampGMT?: Maybe<number | string>;
	deepSleepSeconds?: Maybe<number>;
	lightSleepSeconds?: Maybe<number>;
	remSleepSeconds?: Maybe<number>;
	awakeSleepSeconds?: Maybe<number>;
	unmeasurableSleepSeconds?: Maybe<number>;
	deviceRemCapable?: Maybe<boolean>;
	averageSpO2Value?: Maybe<number>;
	lowestSpO2Value?: Maybe<number>;
	averageRespirationValue?: Maybe<number>;
	awakeCount?: Maybe<number>;
	avgSleepStress?: Maybe<number>;
	avgHeartRate?: Maybe<number>;
	sleepScoreFeedback?: Maybe<string>;
	sleepScores?: Maybe<{ overall?: Maybe<SleepScoreItem>; [k: string]: Maybe<SleepScoreItem> }>;
	sleepNeed?: Maybe<{ actual?: Maybe<number>; baseline?: Maybe<number> }>;
}

export interface HrvSummaryDTO {
	calendarDate?: Maybe<string>;
	weeklyAvg?: Maybe<number>;
	lastNightAvg?: Maybe<number>;
	lastNight5MinHigh?: Maybe<number>;
	baseline?: Maybe<{
		lowUpper?: Maybe<number>;
		balancedLow?: Maybe<number>;
		balancedUpper?: Maybe<number>;
		markerValue?: Maybe<number>;
	}>;
	status?: Maybe<string>;
	feedbackPhrase?: Maybe<string>;
}

export interface HrvDailySummaryDTO {
	hrvSummaries?: Maybe<HrvSummaryDTO[]>;
}

export interface UserDailySummaryV2DTO {
	calendarDate?: Maybe<string>;
	heartRate?: Maybe<{ minValue?: Maybe<number>; maxValue?: Maybe<number>; restingValue?: Maybe<number> }>;
	stress?: Maybe<{ avgLevel?: Maybe<number>; maxLevel?: Maybe<number>; qualifier?: Maybe<string> }>;
	bodyBattery?: Maybe<{
		minValue?: Maybe<number>;
		maxValue?: Maybe<number>;
		chargedValue?: Maybe<number>;
		drainedValue?: Maybe<number>;
		latestValue?: Maybe<number>;
		endOfDayValue?: Maybe<number>;
	}>;
}

export interface DailySummariesV2Response {
	data?: Maybe<UserDailySummaryV2DTO[]>;
}

export interface BodyBatteryDailyReportDTO {
	date?: Maybe<string>;
	charged?: Maybe<number>;
	drained?: Maybe<number>;
	bodyBatteryValuesArray?: Maybe<Array<Array<number | string | null>>>;
	bodyBatteryValueDescriptorDTOList?: Maybe<
		Array<{ bodyBatteryValueDescriptorIndex?: Maybe<number>; bodyBatteryValueDescriptorKey?: Maybe<string> }>
	>;
}
