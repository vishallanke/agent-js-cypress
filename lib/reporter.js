/*
 *  Copyright 2020 EPAM Systems
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

const RPClient = require('@reportportal/client-javascript');
const { entityType, testItemStatuses, logLevels } = require('./constants');
const {
  getFailedScreenshot,
  getPassedScreenshots,
  getCustomScreenshots,
  getTestStartObject,
  getTestEndObject,
  getHookStartObject,
  getAgentInfo,
} = require('./utils');

const { createMergeLaunchLockFile, deleteMergeLaunchLockFile } = require('./mergeLaunchesUtils');

const { FAILED } = testItemStatuses;

const promiseErrorHandler = (promise, message = '') =>
  promise.catch((err) => {
    console.error(message, err);
  });

const getInitialTestFinishParams = () => ({
  attributes: [],
  description: '',
});

class Reporter {
  constructor(config) {
    const agentInfo = getAgentInfo();
    this.client = new RPClient(config.reporterOptions, agentInfo);
    this.testItemIds = new Map();
    this.hooks = new Map();
    this.config = config;

    this.currentTestFinishParams = getInitialTestFinishParams();

    this.currentTestTempInfo = null;
    this.suitesStackTempInfo = [];
    this.suiteTestCaseIds = new Map();
    this.currentTestCustomScreenshots = [];
    this.suiteStatuses = new Map();
  }

  resetCurrentTestFinishParams() {
    console.log("Inside resetCurrentTestFinishParams")
    this.currentTestFinishParams = getInitialTestFinishParams();
  }

  runStart(launchObj) {
    console.log("Inside runStart")
    const { tempId, promise } = this.client.startLaunch(launchObj);
    const { launch, isLaunchMergeRequired } = this.config.reporterOptions;
    if (isLaunchMergeRequired) {
      createMergeLaunchLockFile(launch, tempId);
    }
    promiseErrorHandler(promise, 'Fail to start launch');
    this.tempLaunchId = tempId;
    console.log("Inside runStart END. Launch Id is ", tempId)

  }

  runEnd() {
    console.log("Inside runEnd")

    const finishLaunchPromise = this.client
      .finishLaunch(
        this.tempLaunchId,
        Object.assign(
          {
            endTime: new Date().valueOf(),
          },
          this.launchStatus && { status: this.launchStatus },
        ),
      )
      .promise.then(() => {
        const { launch, isLaunchMergeRequired } = this.config.reporterOptions;
        if (isLaunchMergeRequired) {
          deleteMergeLaunchLockFile(launch, this.tempLaunchId);
        }
      });
      console.log("Inside runStart END")


    return promiseErrorHandler(finishLaunchPromise, 'Fail to finish launch');
  }

  suiteStart(suite) {
    console.log("Inside suiteStart")

    const parentId = suite.parentId && this.testItemIds.get(suite.parentId);
    const { tempId, promise } = this.client.startTestItem(suite, this.tempLaunchId, parentId);
    promiseErrorHandler(promise, 'Fail to start suite');
    this.testItemIds.set(suite.id, tempId);
    this.suitesStackTempInfo.push({ tempId, startTime: suite.startTime });
    console.log("Inside suiteStart END ", suite.id)

  }

  suiteEnd(suite) {
    console.log("Inside suiteEnd")

    const suiteId = this.testItemIds.get(suite.id);
    const suiteTestCaseId = this.suiteTestCaseIds.get(suite.title);
    const suiteStatus = this.suiteStatuses.get(suite.title);
    const finishTestItemPromise = this.client.finishTestItem(
      suiteId,
      Object.assign(
        {
          endTime: new Date().valueOf(),
        },
        suiteTestCaseId && { testCaseId: suiteTestCaseId },
        suiteStatus && { status: suiteStatus },
      ),
    ).promise;
    promiseErrorHandler(finishTestItemPromise, 'Fail to finish suite');
    this.suitesStackTempInfo.pop();
    suiteTestCaseId && this.suiteTestCaseIds.delete(suite.title);
    suiteStatus && this.suiteStatuses.delete(suite.title);
    console.log("Inside suiteEnd END suiteStatus", suiteStatus , suite.title)

  }

  testStart(test) {
    console.log("Inside testStart")

    const parentId = this.testItemIds.get(test.parentId);
    const startTestObj = getTestStartObject(test);
    const { tempId, promise } = this.client.startTestItem(
      startTestObj,
      this.tempLaunchId,
      parentId,
    );
    promiseErrorHandler(promise, 'Fail to start test');
    this.testItemIds.set(test.id, tempId);
    this.currentTestTempInfo = { tempId, startTime: startTestObj.startTime };
    console.log("Inside testStart END test.id ", test.id)

  }

  sendLogOnFinishItem(test, tempTestId) {
    console.log("Inside sendLogOnFinishItem " + test.status)

    const level = test.status === FAILED ? logLevels.ERROR : logLevels.INFO;

    if (test.status === FAILED) {
      const sendFailedLogPromise = this.client.sendLog(
        tempTestId,
        {
          message: test.err,
          level,
          time: new Date().valueOf(),
        },
        getFailedScreenshot(test.title),
      ).promise;
      promiseErrorHandler(sendFailedLogPromise, 'Fail to save error log');
    }
    const passedScreenshots = getPassedScreenshots(test.title);
    const customScreenshots = getCustomScreenshots(
      this.currentTestCustomScreenshots,
      test.testFileName,
      console.log("Inside sendLogOnFinishItem END")

    );

    passedScreenshots.concat(customScreenshots).forEach((file) => {
      console.log("Inside passedScreenshots")

      const sendPassedScreenshotsPromise = this.client.sendLog(
        tempTestId,
        {
          message: 'screenshot',
          level,
          time: new Date().valueOf(),
        },
        file,
      ).promise;
      promiseErrorHandler(sendPassedScreenshotsPromise, 'Fail to save passed log');
    });
    console.log("Inside passedScreenshots END")

  }

  testEnd(test) {
    console.log("Inside testEnd")

    let testId = this.testItemIds.get(test.id);
    if (!testId) {
      this.testStart(test);
      testId = this.testItemIds.get(test.id);
    }
    this.sendLogOnFinishItem(test, testId);
    const testInfo = Object.assign({}, test, this.currentTestFinishParams);
    const finishTestItemPromise = this.client.finishTestItem(
      testId,
      getTestEndObject(testInfo, this.config.reporterOptions.skippedIssue),
    ).promise;
    promiseErrorHandler(finishTestItemPromise, 'Fail to finish test');
    this.resetCurrentTestFinishParams();
    this.currentTestTempInfo = null;
    console.log("Inside testEnd END testId ", testId)

  }

  hookStart(hook) {
    console.log("Inside hookStart")

    const hookStartObject = getHookStartObject(hook);
    switch (hookStartObject.type) {
      case entityType.BEFORE_SUITE:
        hookStartObject.startTime = this.getCurrentSuiteInfo().startTime - 1;
        break;
      case entityType.BEFORE_METHOD:
        hookStartObject.startTime = this.currentTestTempInfo
          ? this.currentTestTempInfo.startTime - 1
          : hookStartObject.startTime;
        break;
      default:
        break;
    }
    this.hooks.set(hook.id, hookStartObject);
    console.log("Inside hookStart END")

  }

  hookEnd(hook) {
    console.log("Inside hookEnd")

    const startedHook = this.hooks.get(hook.id);
    if (!startedHook) return;
    const { tempId, promise } = this.client.startTestItem(
      startedHook,
      this.tempLaunchId,
      this.testItemIds.get(hook.parentId),
    );
    promiseErrorHandler(promise, 'Fail to start hook');
    this.sendLogOnFinishItem(hook, tempId);
    const finishHookPromise = this.client.finishTestItem(tempId, {
      status: hook.status,
      endTime: new Date().valueOf(),
    }).promise;
    this.hooks.delete(hook.id);
    promiseErrorHandler(finishHookPromise, 'Fail to finish hook');
    console.log("Inside hookEnd END")

  }

  getCurrentSuiteInfo() {
    console.log("Inside getCurrentSuiteInfo")

    return this.suitesStackTempInfo.length
      ? this.suitesStackTempInfo[this.suitesStackTempInfo.length - 1]
      : undefined;
  }

  getCurrentSuiteId() {
    console.log("Inside getCurrentSuiteId")

    const currentSuiteInfo = this.getCurrentSuiteInfo();
    console.log("Inside getCurrentSuiteId END")

    return currentSuiteInfo && currentSuiteInfo.tempId;

  }

  sendLog(tempId, { level, message = '', file }) {
    console.log("Inside sendLog")

    this.client.sendLog(
      tempId,
      {
        message,
        level,
        time: new Date().valueOf(),
      },
      file,
    );
    console.log("Inside sendLog END")

  }

  sendLogToCurrentItem(log) {
    console.log("Inside sendLogToCurrentItem")

    const tempItemId =
      (this.currentTestTempInfo && this.currentTestTempInfo.tempId) || this.getCurrentSuiteId();
    tempItemId && this.sendLog(tempItemId, log);
    console.log("Inside sendLogToCurrentItem END")

  }

  sendLaunchLog(log) {
    console.log("Inside sendLaunchLog")

    this.sendLog(this.tempLaunchId, log);
    console.log("Inside sendLaunchLog END")

  }

  addAttributes(attributes) {
    console.log("Inside addAttributes")

    this.currentTestFinishParams.attributes = this.currentTestFinishParams.attributes.concat(
      attributes || [],
    );
    console.log("Inside addAttributes END")

  }

  setDescription(description) {
    this.currentTestFinishParams.description = description;
  }

  setTestCaseId({ testCaseId, suiteTitle }) {
    console.log("Inside setTestCaseId")

    if (suiteTitle) {
      this.suiteTestCaseIds.set(suiteTitle, testCaseId);
    } else {
      Object.assign(this.currentTestFinishParams, testCaseId && { testCaseId });
    }
    console.log("Inside setTestCaseId END")

  }

  setTestItemStatus({ status, suiteTitle }) {
    console.log("Inside setTestItemStatus")

    if (suiteTitle) {
      this.suiteStatuses.set(suiteTitle, status);
    } else {
      Object.assign(this.currentTestFinishParams, status && { status });
    }
    console.log("Inside setTestItemStatus END")

  }

  setLaunchStatus({ status }) {
    console.log("Inside setLaunchStatus")

    this.launchStatus = status;
    console.log("Inside setLaunchStatus END")

  }

  saveCustomScreenshotFilename({ fileName }) {
    console.log("Inside saveCustomScreenshotFilename")

    this.currentTestCustomScreenshots.push(fileName);
  console.log("Inside saveCustomScreenshotFilename END")

  }

}

module.exports = Reporter;
