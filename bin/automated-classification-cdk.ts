#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { AutomatedClassificationCdkStack } from '../lib/automated-classification-cdk-stack';
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';

const app = new cdk.App();

// Get runtime props from context or use defaults
const emailBucketName = app.node.tryGetContext('emailBucketName');
const emailOutputBucketName = app.node.tryGetContext('emailOutputBucketName');
const glueDatabaseName = app.node.tryGetContext('glueDatabaseName');
const glueCrawlerName = app.node.tryGetContext('glueCrawlerName');
const quicksightDataSetName = app.node.tryGetContext('quicksightDataSetName');
const quicksightUserArn = app.node.tryGetContext('quicksightUserArn');
const destroyData = app.node.tryGetContext('destroyData');
const llmModelId = app.node.tryGetContext('llmModelId');
const targetRegion = app.node.tryGetContext('region') || 'us-east-1';

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
new AutomatedClassificationCdkStack(app, 'AutomatedClassificationCdkStack', {
  stackName: `AutomatedClassificationCdkStack`,
	description: `(tag:pipeline)`,
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: targetRegion },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
   
  // Pass runtime props to the stack
  ...(emailBucketName && { emailBucketName }),
  ...(emailOutputBucketName && { emailOutputBucketName }),
  ...(glueDatabaseName && { glueDatabaseName }),
  ...(glueCrawlerName && { glueCrawlerName }),
  ...(quicksightDataSetName && { quicksightDataSetName }),
  ...(quicksightUserArn && { quicksightUserArn }),
  ...(destroyData && { destroyData }),
  ...(llmModelId && { llmModelId }),
});


