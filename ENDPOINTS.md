# Garmin Personal API: endpoint access check

Verified 2026-11-05 with this connector's API key, using read-only GETs. Recorded: HTTP status and response **shape only** (key names, no values).
OpenAPI spec: extracted from the swagger-docs page bundle (developer.garmin.com/gc-developer-program/personal/swagger-docs/).

## Results

| Endpoint | Status | Content type | Notes |
|---|---|---|---|
| `GET /activitylist-service/activities/search/activities?start&limit` | 200 | application/json | paginate with start/limit (limit=1000 accepted) |
| `GET /activity-service/activity/{id} (running)` | 200 | application/json |  |
| `GET /activity-service/activity/{id} (strength)` | 200 | application/json |  |
| `GET /activity-service/activity/{id}/workouts (running)` | 200 | application/json | 200 but empty array (activity not started from a planned workout) |
| `GET /activity-service/activity/{id}/workouts (strength)` | 200 | application/json | 200 but empty array |
| `GET /download-service/files/activity/{id} (running)` | 200 | application/x-zip-compressed | ZIP with one `{id}_ACTIVITY.fit` (FIT CRC valid) |
| `GET /download-service/files/activity/{id} (strength)` | 200 | application/x-zip-compressed | ZIP with one `{id}_ACTIVITY.fit`; contains `set` messages |
| `GET /hrv-service/hrv/daily/{from}/{to}` | 200 | application/json | 204 = no data; a 309-day range is accepted |
| `GET /sleep-service/sleep/dailySleepSummariesByDate` | 200 | application/json | max 31 days (400 above) |
| `GET /usersummary-service/v2/dailysummaries` | 200 | application/json | max 1 year (400 above) |
| `GET /biometric-service/heartRateZones/v2 (extra)` | 200 | application/json |  |
| `GET /userprofile-service/userprofile/settings (extra)` | 200 | application/json |  |

| `GET /fitnessage-service/fitnessage/v2/{date}?fullHistoryScan=true` | 200 | application/json | Garmin Fitness Age + components; used by `get_fitness_age` |

## Fields of interest

| Metric | Activity search (`SummarizedActivityDTO`) | Activity detail (`summaryDTO`) | FIT file |
|---|---|---|---|
| VO2 max | `vO2MaxValue` in spec, **absent in real activities (verified on one account)** | not present | **undocumented message 140, field 7** (raw × 3.5 / 65536); present on outdoor runs, 0 on treadmill (validated against a Garmin watch, which rounds to an integer) |
| Training effect | `aerobicTrainingEffect`, `anaerobicTrainingEffect`, `trainingEffectLabel` | `trainingEffect`, `anaerobicTrainingEffect`, `trainingEffectLabel` | session `totalTrainingEffect`, `totalAnaerobicTrainingEffect` |
| Training load | `activityTrainingLoad` | `activityTrainingLoad` | session `trainingLoadPeak` |
| Avg cadence | `averageRunningCadenceInStepsPerMinute` | `averageRunCadence` | lap `avgCadence` + `avgFractionalCadence` |
| Stride length | `avgStrideLength` | `strideLength` | lap `avgStepLength` |
| Power | `avgPower`, `maxPower`, `normPower` | `averagePower`, `maxPower`, `normalizedPower` | lap `avgPower`, `maxPower`, `normalizedPower` |
| Running dynamics | `avgVerticalOscillation`, `avgVerticalRatio` | `groundContactTime`, `verticalOscillation`, `verticalRatio` | lap `avgVerticalOscillation`, `avgStanceTime`, `avgVerticalRatio` |
| Laps | `lapCount` only | `splitSummaries` (aggregates per split type, not laps) | `lap` messages |
| Strength sets | – | `totalExerciseReps`, `activeSets` | `set` messages: `repetitions`, `weight`, `category`, `categorySubtype`, `setType`, `duration` |
| Lactate threshold | `lactateThresholdBpm` in spec, absent in data | `lactateThresholdHeartRate/Speed` in spec, absent in data | – |

## Diff against the OpenAPI spec

- Every candidate path is in the spec, and all of them returned 200.
- Spec paths outside the candidate list, which these features don't need: `/biometric-service/heartRateZones/v2`, `/fitnessage-service/fitnessage/v2/{calendarDate}`, `/goal-service/goal/user/effective/weightgoal/{startDate}/{endDate}`, `/hrv-service/hrv/{calendarDate}`, `/nutrition-service/food/logs/{date}`, `/periodichealth-service/menstrualcycle/summary/{calendarDate}`, `/periodichealth-service/menstrualcycle/dayview/{calendarDate}`, `/sleep-service/sleep/dailySleep`, `/userprofile-service/userprofile/settings`, `/usersummary-service/stats/hydration/daily/{startDate}/{endDate}`, `/usersummary-service/stats/steps/daily/{startDate}/{endDate}`, `/usersummary-service/stats/stress/daily/{startDate}/{endDate}`, `/usersummary-service/usersummary/daily`, `/weight-service/weight/all/{startDate}/{endDate}`, `/weight-service/weight/range/{startDate}/{endDate}`, `/wellness-service/wellness/bodyBattery/reports/daily`, `/wellness-service/wellness/daily/spo2acclimation/{calendarDate}`, `/wellness-service/wellness/dailyHeartRate`.
- Not in the spec at all, so not available: Training Readiness, Training Status, race predictions, VO2 max history, lactate threshold history, and any write or push endpoints (workouts, courses).

## Built / skipped

- Built: every new feature uses only endpoints that returned 200.
- `/activity-service/activity/{id}/workouts` returns 200 but is empty for these activities, so it is not used.
- VO2 max is not in any API field. `get_vo2max_trend` reads the watch's estimate from the FIT file instead (message 140, validated against the watch), and also uses `vO2MaxValue` if Garmin ever populates it.
- Lactate threshold fields are defined in the spec but empty, so they are not exposed.

## Response shapes (keys only)

### GET /activitylist-service/activities/search/activities?start&limit

```
[].activityId
[].activityName
[].startTimeLocal
[].startTimeGMT
[].activityType.typeId
[].activityType.typeKey
[].activityType.parentTypeId
[].eventType.typeId
[].eventType.typeKey
[].isFavorite
[].isPR
[].isAutoCalcCalories
[].isParent
[].distance
[].duration
[].elapsedDuration
[].movingDuration
[].averageSpeed
[].maxSpeed
[].hasImages
[].ownerId
[].ownerDisplayName
[].ownerFullName
[].ownerProfileImageUrlSmall
[].ownerProfileImageUrlMedium
[].ownerProfileImageUrlLarge
[].calories
[].bmrCalories
[].averageHR
[].maxHR
[].averageRunningCadenceInStepsPerMinute
[].maxRunningCadenceInStepsPerMinute
[].steps
[].privacy.typeId
[].privacy.typeKey
[].hasVideo
[].beginTimestamp
[].sportTypeId
[].avgPower
[].maxPower
[].aerobicTrainingEffect
[].anaerobicTrainingEffect
[].normPower
[].avgVerticalOscillation
[].avgGroundContactTime
[].avgStrideLength
[].avgVerticalRatio
[].maxDoubleCadence
[].isElevationCorrected
[].isDecoDive
[].summarizedDiveInfo.summarizedDiveGases[]
[].manufacturer
[].lapCount
[].waterEstimated
[].trainingEffectLabel
[].activityTrainingLoad
[].minActivityLapDuration
[].aerobicTrainingEffectMessage
[].anaerobicTrainingEffectMessage
[].splitSummaries[].noOfSplits
[].splitSummaries[].duration
[].splitSummaries[].splitType
[].splitSummaries[].maxDistance
[].splitSummaries[].maxDistanceWithPrecision
[].splitSummaries[].distance
[].splitSummaries[].averageSpeed
[].splitSummaries[].maxSpeed
[].splitSummaries[].avgStepFrequency
[].isManualActivity
[].moderateIntensityMinutes
[].vigorousIntensityMinutes
[].differenceBodyBattery
[].hrTimeInZone_1
[].hrTimeInZone_2
[].hrTimeInZone_3
[].hrTimeInZone_4
[].hrTimeInZone_5
[].powerTimeInZone_1
[].powerTimeInZone_2
[].powerTimeInZone_3
[].powerTimeInZone_4
[].powerTimeInZone_5
[].endTimeGMT
[].qualifyingDive
[].activityUUID
[].autoCalcCalories
[].favorite
[].elevationCorrected
[].decoDive
[].pr
[].manualActivity
[].parent
```

### GET /activity-service/activity/{id} (running)

```
activityId
activityUUID.uuid
activityName
userProfileId
isMultiSportParent
activityTypeDTO.typeId
activityTypeDTO.typeKey
activityTypeDTO.parentTypeId
eventTypeDTO.typeId
eventTypeDTO.typeKey
accessControlRuleDTO.typeId
accessControlRuleDTO.typeKey
timeZoneUnitDTO.timeZone
metadataDTO.isOriginal
metadataDTO.fileFormat.formatId
metadataDTO.fileFormat.formatKey
metadataDTO.lastUpdateDate
metadataDTO.uploadedDate
metadataDTO.videoUrl
metadataDTO.userInfoDto.userProfilePk
metadataDTO.userInfoDto.displayname
metadataDTO.userInfoDto.fullname
metadataDTO.userInfoDto.profileImageUrlLarge
metadataDTO.userInfoDto.profileImageUrlMedium
metadataDTO.userInfoDto.profileImageUrlSmall
metadataDTO.userInfoDto.userPro
metadataDTO.childIds[]
metadataDTO.childActivityTypes[]
metadataDTO.sensors[].serialNumber
metadataDTO.sensors[].sourceType
metadataDTO.sensors[].batteryStatus
metadataDTO.sensors[].bleDeviceType
metadataDTO.sensors[].batteryLevel
metadataDTO.activityImages[]
metadataDTO.manufacturer
metadataDTO.lapCount
metadataDTO.hasRunPowerWindData
metadataDTO.calendarEventInfo
metadataDTO.hasMultiDayActivities
metadataDTO.personalRecord
metadataDTO.gcj02
metadataDTO.runPowerWindDataEnabled
metadataDTO.autoCalcCalories
metadataDTO.favorite
metadataDTO.manualActivity
metadataDTO.elevationCorrected
metadataDTO.trimmed
summaryDTO.startTimeLocal
summaryDTO.startTimeGMT
summaryDTO.distance
summaryDTO.duration
summaryDTO.movingDuration
summaryDTO.elapsedDuration
summaryDTO.averageSpeed
summaryDTO.averageMovingSpeed
summaryDTO.maxSpeed
summaryDTO.calories
summaryDTO.bmrCalories
summaryDTO.averageHR
summaryDTO.maxHR
summaryDTO.minHR
summaryDTO.averageRunCadence
summaryDTO.maxRunCadence
summaryDTO.averagePower
summaryDTO.maxPower
summaryDTO.minPower
summaryDTO.normalizedPower
summaryDTO.totalWork
summaryDTO.groundContactTime
summaryDTO.strideLength
summaryDTO.verticalOscillation
summaryDTO.trainingEffect
summaryDTO.anaerobicTrainingEffect
summaryDTO.aerobicTrainingEffectMessage
summaryDTO.anaerobicTrainingEffectMessage
summaryDTO.verticalRatio
summaryDTO.waterEstimated
summaryDTO.trainingEffectLabel
summaryDTO.activityTrainingLoad
summaryDTO.minActivityLapDuration
summaryDTO.directWorkoutFeel
summaryDTO.directWorkoutRpe
summaryDTO.moderateIntensityMinutes
summaryDTO.vigorousIntensityMinutes
summaryDTO.steps
summaryDTO.recoveryHeartRate
summaryDTO.differenceBodyBattery
splitSummaries[].distance
splitSummaries[].duration
splitSummaries[].movingDuration
splitSummaries[].averageSpeed
splitSummaries[].maxSpeed
splitSummaries[].calories
splitSummaries[].bmrCalories
splitSummaries[].averageHR
splitSummaries[].maxHR
splitSummaries[].averageRunCadence
splitSummaries[].maxRunCadence
splitSummaries[].averagePower
splitSummaries[].maxPower
splitSummaries[].normalizedPower
splitSummaries[].strideLength
splitSummaries[].totalExerciseReps
splitSummaries[].splitType
splitSummaries[].noOfSplits
splitSummaries[].maxDistance
splitSummaries[].maxDistanceWithPrecision
splitSummaries[].avgStepFrequency
```

### GET /activity-service/activity/{id} (strength)

```
activityId
activityUUID.uuid
activityName
userProfileId
isMultiSportParent
activityTypeDTO.typeId
activityTypeDTO.typeKey
activityTypeDTO.parentTypeId
eventTypeDTO.typeId
eventTypeDTO.typeKey
accessControlRuleDTO.typeId
accessControlRuleDTO.typeKey
timeZoneUnitDTO.timeZone
metadataDTO.isOriginal
metadataDTO.fileFormat.formatId
metadataDTO.fileFormat.formatKey
metadataDTO.lastUpdateDate
metadataDTO.uploadedDate
metadataDTO.videoUrl
metadataDTO.userInfoDto.userProfilePk
metadataDTO.userInfoDto.displayname
metadataDTO.userInfoDto.fullname
metadataDTO.userInfoDto.profileImageUrlLarge
metadataDTO.userInfoDto.profileImageUrlMedium
metadataDTO.userInfoDto.profileImageUrlSmall
metadataDTO.userInfoDto.userPro
metadataDTO.childIds[]
metadataDTO.childActivityTypes[]
metadataDTO.sensors
metadataDTO.activityImages[]
metadataDTO.manufacturer
metadataDTO.lapCount
metadataDTO.hasRunPowerWindData
metadataDTO.calendarEventInfo
metadataDTO.hasMultiDayActivities
metadataDTO.manualActivity
metadataDTO.trimmed
metadataDTO.elevationCorrected
metadataDTO.runPowerWindDataEnabled
metadataDTO.autoCalcCalories
metadataDTO.favorite
metadataDTO.personalRecord
metadataDTO.gcj02
summaryDTO.startTimeLocal
summaryDTO.startTimeGMT
summaryDTO.distance
summaryDTO.duration
summaryDTO.movingDuration
summaryDTO.elapsedDuration
summaryDTO.averageSpeed
summaryDTO.averageMovingSpeed
summaryDTO.calories
summaryDTO.bmrCalories
summaryDTO.averageHR
summaryDTO.maxHR
summaryDTO.minHR
summaryDTO.averageTemperature
summaryDTO.maxTemperature
summaryDTO.minTemperature
summaryDTO.trainingEffect
summaryDTO.anaerobicTrainingEffect
summaryDTO.aerobicTrainingEffectMessage
summaryDTO.anaerobicTrainingEffectMessage
summaryDTO.totalExerciseReps
summaryDTO.activeSets
summaryDTO.waterEstimated
summaryDTO.trainingEffectLabel
summaryDTO.activityTrainingLoad
summaryDTO.minActivityLapDuration
summaryDTO.moderateIntensityMinutes
summaryDTO.vigorousIntensityMinutes
summaryDTO.steps
summaryDTO.differenceBodyBattery
```

### GET /activity-service/activity/{id}/workouts (running)

```
[]
```

### GET /activity-service/activity/{id}/workouts (strength)

```
[]
```

### GET /download-service/files/activity/{id} (running)

Binary ZIP (42170 bytes).

### GET /download-service/files/activity/{id} (strength)

Binary ZIP (13352 bytes).

### GET /hrv-service/hrv/daily/{from}/{to}

```
hrvSummaries[].calendarDate
hrvSummaries[].weeklyAvg
hrvSummaries[].lastNightAvg
hrvSummaries[].lastNight5MinHigh
hrvSummaries[].baseline.lowUpper
hrvSummaries[].baseline.balancedLow
hrvSummaries[].baseline.balancedUpper
hrvSummaries[].baseline.markerValue
hrvSummaries[].status
hrvSummaries[].feedbackPhrase
hrvSummaries[].createTimeStamp
userProfilePk
```

### GET /sleep-service/sleep/dailySleepSummariesByDate

```
[].id
[].userProfilePK
[].calendarDate
[].sleepTimeSeconds
[].napTimeSeconds
[].sleepWindowConfirmed
[].sleepWindowConfirmationType
[].sleepStartTimestampGMT
[].sleepEndTimestampGMT
[].sleepStartTimestampLocal
[].sleepEndTimestampLocal
[].autoSleepStartTimestampGMT
[].autoSleepEndTimestampGMT
[].sleepQualityTypePK
[].sleepResultTypePK
[].unmeasurableSleepSeconds
[].deepSleepSeconds
[].lightSleepSeconds
[].remSleepSeconds
[].awakeSleepSeconds
[].deviceRemCapable
[].retro
[].sleepFromDevice
[].averageSpO2Value
[].lowestSpO2Value
[].highestSpO2Value
[].numberOfEventsBelowThreshold
[].averageSpO2HRSleep
[].spo2Threshold
[].averageRespirationValue
[].lowestRespirationValue
[].highestRespirationValue
[].awakeCount
[].avgSleepStress
[].ageGroup
[].avgHeartRate
[].sleepScoreFeedback
[].sleepScoreInsight
[].sleepScorePersonalizedInsight
[].sleepScores.totalDuration.qualifierKey
[].sleepScores.totalDuration.optimalStart
[].sleepScores.totalDuration.optimalEnd
[].sleepScores.stress.qualifierKey
[].sleepScores.stress.optimalStart
[].sleepScores.stress.optimalEnd
[].sleepScores.awakeCount.qualifierKey
[].sleepScores.awakeCount.optimalStart
[].sleepScores.awakeCount.optimalEnd
[].sleepScores.overall.value
[].sleepScores.overall.qualifierKey
[].sleepScores.remPercentage.value
[].sleepScores.remPercentage.qualifierKey
[].sleepScores.remPercentage.optimalStart
[].sleepScores.remPercentage.optimalEnd
[].sleepScores.remPercentage.idealStartInSeconds
[].sleepScores.remPercentage.idealEndInSeconds
[].sleepScores.restlessness.qualifierKey
[].sleepScores.restlessness.optimalStart
[].sleepScores.restlessness.optimalEnd
[].sleepScores.lightPercentage.value
[].sleepScores.lightPercentage.qualifierKey
[].sleepScores.lightPercentage.optimalStart
[].sleepScores.lightPercentage.optimalEnd
[].sleepScores.lightPercentage.idealStartInSeconds
[].sleepScores.lightPercentage.idealEndInSeconds
[].sleepScores.deepPercentage.value
[].sleepScores.deepPercentage.qualifierKey
[].sleepScores.deepPercentage.optimalStart
[].sleepScores.deepPercentage.optimalEnd
[].sleepScores.deepPercentage.idealStartInSeconds
[].sleepScores.deepPercentage.idealEndInSeconds
[].userNote
[].kidSleepNote
[].sleepVersion
[].sleepNeed.userProfilePk
[].sleepNeed.calendarDate
[].sleepNeed.deviceId
[].sleepNeed.timestampGmt
[].sleepNeed.baseline
[].sleepNeed.actual
[].sleepNeed.feedback
[].sleepNeed.trainingFeedback
[].sleepNeed.sleepHistoryAdjustment
[].sleepNeed.hrvAdjustment
[].sleepNeed.napAdjustment
[].sleepNeed.displayedForTheDay
[].sleepNeed.preferredActivityTracker
[].nextSleepNeed.userProfilePk
[].nextSleepNeed.calendarDate
[].nextSleepNeed.deviceId
[].nextSleepNeed.timestampGmt
[].nextSleepNeed.baseline
[].nextSleepNeed.actual
[].nextSleepNeed.feedback
[].nextSleepNeed.trainingFeedback
[].nextSleepNeed.sleepHistoryAdjustment
[].nextSleepNeed.hrvAdjustment
[].nextSleepNeed.napAdjustment
[].nextSleepNeed.displayedForTheDay
[].nextSleepNeed.preferredActivityTracker
[].dailyNapDTOS
[].breathingDisruptionSeverity
[].sleepAlignment
```

### GET /usersummary-service/v2/dailysummaries

```
data[].uuid
data[].userProfilePk
data[].calendarDate
data[].source
data[].includesWellnessData
data[].includesActivityData
data[].wellnessChronology.startTimestampGmt
data[].wellnessChronology.startTimestampLocal
data[].wellnessChronology.endTimestampGmt
data[].wellnessChronology.endTimestampLocal
data[].wellnessChronology.totalDurationInMillis
data[].movement.steps.goal
data[].movement.steps.value
data[].movement.steps.distanceInMeters
data[].movement.floorsAscended.goal
data[].movement.floorsAscended.value
data[].movement.floorsAscended.distanceInMeters
data[].movement.floorsDescended.value
data[].movement.floorsDescended.distanceInMeters
data[].calories.burnedResting
data[].calories.burnedActive
data[].calories.burnedTotal
data[].heartRate.minValue
data[].heartRate.maxValue
data[].heartRate.restingValue
data[].intensityMinutes.goal
data[].intensityMinutes.moderate
data[].intensityMinutes.vigorous
data[].stress.avgLevel
data[].stress.maxLevel
data[].stress.restProportion
data[].stress.activityProportion
data[].stress.uncategorizedProportion
data[].stress.lowStressProportion
data[].stress.mediumStressProportion
data[].stress.highStressProportion
data[].stress.qualifier
data[].stress.totalDurationInMillis
data[].stress.restDurationInMillis
data[].stress.activityDurationInMillis
data[].stress.uncategorizedDurationInMillis
data[].stress.lowStressDurationInMillis
data[].stress.mediumStressDurationInMillis
data[].stress.highStressDurationInMillis
data[].bodyBattery.minValue
data[].bodyBattery.maxValue
data[].bodyBattery.chargedValue
data[].bodyBattery.drainedValue
data[].bodyBattery.latestValue
data[].bodyBattery.featureVersion
data[].bodyBattery.dynamicFeedbackEvent.eventTimestampGmt
data[].bodyBattery.dynamicFeedbackEvent.bodyBatteryLevel
data[].bodyBattery.dynamicFeedbackEvent.feedbackShortType
data[].bodyBattery.dynamicFeedbackEvent.feedbackLongType
data[].bodyBattery.endOfDayDynamicFeedbackEvent.eventTimestampGmt
data[].bodyBattery.endOfDayDynamicFeedbackEvent.bodyBatteryLevel
data[].bodyBattery.endOfDayDynamicFeedbackEvent.feedbackShortType
data[].bodyBattery.endOfDayDynamicFeedbackEvent.feedbackLongType
data[].bodyBattery.activityEvents[].eventType
data[].bodyBattery.activityEvents[].eventStartTimeGmt
data[].bodyBattery.activityEvents[].eventStartTimeLocal
data[].bodyBattery.activityEvents[].bodyBatteryImpact
data[].bodyBattery.activityEvents[].feedbackType
data[].bodyBattery.activityEvents[].shortFeedback
data[].bodyBattery.activityEvents[].deviceId
data[].bodyBattery.activityEvents[].durationInMillis
data[].respiration.avgValue
data[].respiration.maxValue
data[].respiration.minValue
data[].respiration.latestValue
data[].respiration.latestTimestampGmt
data[].respiration.algorithmVersion
data[].pulseOx.avgValue
data[].pulseOx.minValue
data[].pulseOx.latestValue
data[].pulseOx.latestTimestampGmt
data[].pulseOx.latestTimestampLocal
data[].pulseOx.avgAltitudeInMeters
```

### GET /biometric-service/heartRateZones/v2 (extra)

```
[].trainingMethod
[].restingHeartRateUsed
[].lactateThresholdHeartRateUsed
[].zone1Floor
[].zone2Floor
[].zone3Floor
[].zone4Floor
[].zone5Floor
[].maxHeartRateUsed
[].restingHrAutoUpdateUsed
[].sport
```

### GET /userprofile-service/userprofile/settings (extra)

```
displayName
preferredLocale
measurementSystem
firstDayOfWeek.dayId
firstDayOfWeek.dayName
firstDayOfWeek.sortOrder
firstDayOfWeek.isPossibleFirstDay
numberFormat
timeFormat.formatId
timeFormat.formatKey
timeFormat.minFraction
timeFormat.maxFraction
timeFormat.groupingUsed
timeFormat.displayFormat
dateFormat.formatId
dateFormat.formatKey
dateFormat.minFraction
dateFormat.maxFraction
dateFormat.groupingUsed
dateFormat.displayFormat
powerFormat.formatId
powerFormat.formatKey
powerFormat.minFraction
powerFormat.maxFraction
powerFormat.groupingUsed
powerFormat.displayFormat
heartRateFormat.formatId
heartRateFormat.formatKey
heartRateFormat.minFraction
heartRateFormat.maxFraction
heartRateFormat.groupingUsed
heartRateFormat.displayFormat
timeZone
hydrationMeasurementUnit
hydrationContainers[]
golfDistanceUnit
golfElevationUnit
golfSpeedUnit
availableTrainingDays
preferredLongTrainingDays
```
