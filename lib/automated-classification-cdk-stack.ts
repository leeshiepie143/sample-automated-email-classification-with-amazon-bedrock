// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { NagSuppressions } from 'cdk-nag';

interface AutomatedClassificationCdkStackProps extends cdk.StackProps {
  emailBucketName?: string;
  emailOutputBucketName?: string;
  glueDatabaseName?: string;
  glueCrawlerName?: string;
  quicksightDataSetName?: string;
  quicksightUserArn?: string;
  destroyData?: boolean;
  llmModelId?: string;
}

export class AutomatedClassificationCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AutomatedClassificationCdkStackProps = {}) {
    super(scope, id, props);

    // Define parameters with default values
    const emailBucketName = props.emailBucketName || `${this.account}-email-triage-bucket-demo`;
    const emailOutputBucketName = props.emailOutputBucketName || `${this.account}-email-output-bucket-demo`;
    const glueDatabaseName = props.glueDatabaseName || 'email_triage_db_demo';
    const glueCrawlerName = props.glueCrawlerName || 'email-triage-crawler-demo';
    const quicksightDataSetName = props.quicksightDataSetName || 'email-triage-dataset';
    const quicksightUserArn = props.quicksightUserArn || `arn:aws:quicksight:${this.region}:${this.account}:user/default/admin`;
    const dataRemovalPolicy = (props.destroyData || false) ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const autoDeleteObjects = props.destroyData || false;
    const llmModelId = props.llmModelId || 'amazon.nova-pro-v1:0';

    const stateMachineName = 'EmailTriageStateMachine';

    // S3 Bucket for Email Access Logs
    const logBucket = new s3.Bucket(this, 'EmailLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: autoDeleteObjects,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true
    });

    // S3 Bucket for Email Storage
    const emailBucket = new s3.Bucket(this, 'EmailBucket', {
      bucketName: emailBucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: dataRemovalPolicy,
      eventBridgeEnabled: true,
      autoDeleteObjects: autoDeleteObjects,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'email-bucket-logs/',
      enforceSSL: true
    });

    // S3 Bucket for Email Storage
    const emailOutputBucket = new s3.Bucket(this, 'EmailOutputBucket', {
      bucketName: emailOutputBucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: dataRemovalPolicy,
      eventBridgeEnabled: false,
      autoDeleteObjects: autoDeleteObjects,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'output-bucket-logs/'
    });

    // IAM Role for Step Functions
    const stepFunctionsExecutionRole = new iam.Role(this, 'StepFunctionsExecutionRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies:
      {
        'stateMachinePolicy':
          new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              resources: [
                emailBucket.bucketArn,
                `${emailBucket.bucketArn}/*`,
                emailOutputBucket.bucketArn,
                `${emailOutputBucket.bucketArn}/*`
              ],
            }),
            new iam.PolicyStatement({
              actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:${this.stackName}-${stateMachineName}*`],
            }),
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:*::foundation-model/*`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/*`
              ],
            }),
            new iam.PolicyStatement({
              actions: ['glue:GetCrawler', 'glue:StartCrawler'],
              resources: [`arn:aws:glue:${this.region}:${this.account}:crawler/${glueCrawlerName}`],
            }),
          ],
        }),
      }
    });

    // Create a new KMS key for CloudWatch Logs encryption
    const logsKey = new cdk.aws_kms.Key(this, 'LogsKey', {
      description: 'KMS key for CloudWatch Logs encryption',
      enableKeyRotation: true,
      removalPolicy: dataRemovalPolicy
    });

    logsKey.grantEncryptDecrypt(new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`));
    logsKey.grantEncryptDecrypt(new iam.ServicePrincipal('glue.amazonaws.com'));

    // IAM Role for Glue Crawler
    const glueCrawlerRole = new iam.Role(this, 'GlueCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        new iam.ManagedPolicy(this, 'EmailTriageGlueCrawlerRole', {
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                        "glue:GetSecurityConfiguration"],
              resources: [
                '*'
              ],
            }),
            new iam.PolicyStatement({
              actions: ["s3:GetObject",
                        "s3:ListBucket"],
              resources: [
                `${emailOutputBucket.bucketArn}`,
                `${emailOutputBucket.bucketArn}/*`
              ],
            }),
            new iam.PolicyStatement({
              actions: ["glue:GetDatabase",
                        "glue:GetTable",
                        "glue:CreateDatabase",
                        "glue:CreateTable",
                        "glue:UpdateTable"],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:catalog`
              ],
            }),
            new iam.PolicyStatement({
              actions: ["glue:GetTable",
                        "glue:CreateTable",
                        "glue:UpdateTable"],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:table/${glueDatabaseName}/*`
              ],
            }),
            new iam.PolicyStatement({
              actions: ["glue:GetDatabase",
                        "glue:CreateDatabase",
                         "glue:GetTable",
                          "glue:CreateTable",
                           "glue:UpdateTable"],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:database/${glueDatabaseName}`
              ]}),
            new iam.PolicyStatement({
              actions: ["logs:AssociateKmsKey"],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws-glue/crawlers-role/*`
              ]
            }),
          ]
        })

      ]
    });

    // Create Glue Security Configuration with CloudWatch Logs encryption
    const securityConfig = new glue.CfnSecurityConfiguration(this, 'GlueSecurityConfig', {
      name: 'email-triage-security-config',
      encryptionConfiguration: {
        s3Encryptions: [
          {
            s3EncryptionMode: 'SSE-S3'
          }
        ],
        cloudWatchEncryption: {
          cloudWatchEncryptionMode: 'SSE-KMS',
          kmsKeyArn: logsKey.keyArn
        }
      }
    });

    // Glue Crawler
    const emailTriageCrawler = new glue.CfnCrawler(this, 'EmailTriageCrawler', {
      name: glueCrawlerName,
      role: glueCrawlerRole.roleArn,
      databaseName: glueDatabaseName,
      targets: {
        s3Targets: [
          {
            path: `s3://${emailOutputBucketName}/`,
          },
        ],
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
      crawlerSecurityConfiguration: securityConfig.name,
      configuration: JSON.stringify({
        Version: 1.0,
        CrawlerOutput: {
          Tables: {
            AddOrUpdateBehavior: 'MergeNewColumns',
          },
        },
      }),
    });

    // Step Functions State Machine Definition using JSONata
    const stateMachineDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'ParseInput',
      States: {
        ParseInput: {
          Type: 'Pass',
          Output: '{% { "body": $parse($states.input[0].body) } %}',
          Next: 'GetEmailFromS3'
        },
        GetEmailFromS3: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:s3:getObject',
          Arguments: {
            Bucket: emailBucketName,
            Key: '{% $states.input.body.detail.object.key %}'
          },
          Output: '{% { "data": $states.result.Body } %}',
          Next: 'InvokeBedrock',
          Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 3, BackoffRate: 2 }]
        },
        InvokeBedrock: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:bedrockruntime:converse',
          Arguments: {
            ModelId: llmModelId,
            System: [{ Text: 'You are an assistant providing email triage. Respond with ONLY valid JSON, no markdown.' }],
            Messages: [{
              Role: 'user',
              Content: [{
                Text: '{% "Analyze this email and respond with JSON: {\\\"response\\\":{\\\"target_department\\\":\\\"transport|benefits|council tax|social care|waste|environmental health|general\\\",\\\"severity\\\":\\\"low|medium|high\\\",\\\"urgency\\\":\\\"immediate|this week|this month|not urgent\\\",\\\"topic\\\":\\\"primary topic\\\",\\\"summary\\\":\\\"1 paragraph summary\\\"}}. Email: " & $states.input.data %}'
              }]
            }],
            InferenceConfig: { MaxTokens: 1024 }
          },
          Output: '{% ( $raw := $states.result.Output.Message.Content[0].Text; $trimmed := $trim($raw); $hasCodeBlock := $contains($trimmed, "```"); $cleaned := $hasCodeBlock ? $trim($replace($replace($trimmed, /```json?\\n?/, ""), /```$/, "")) : $trimmed; $parse($cleaned) ) %}',
          Next: 'ExtractResponse',
          Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 10, MaxAttempts: 3, BackoffRate: 2 }]
        },
        ExtractResponse: {
          Type: 'Pass',
          Output: `{% {
            "response": {
              "target_department": $states.input.response.target_department,
              "severity": $states.input.response.severity,
              "urgency": $states.input.response.urgency,
              "topic": $states.input.response.topic,
              "summary": $states.input.response.summary,
              "timestamp": $now()
            }
          } %}`,
          Next: 'WriteOutputToS3'
        },
        WriteOutputToS3: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:s3:putObject',
          Arguments: {
            Bucket: emailOutputBucketName,
            Key: '{% $uuid() %}',
            Body: '{% $states.input.response %}'
          },
          Output: '{% $states.input %}',
          Next: 'GetGlueCrawler'
        },
        GetGlueCrawler: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:glue:getCrawler',
          Arguments: { Name: glueCrawlerName },
          Next: 'CheckCrawler'
        },
        CheckCrawler: {
          Type: 'Choice',
          Choices: [{ Condition: '{% $states.input.Crawler.State = "READY" %}', Next: 'StartGlueCrawler' }],
          Default: 'CrawlerNotReady'
        },
        StartGlueCrawler: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:glue:startCrawler',
          Arguments: { Name: glueCrawlerName },
          End: true
        },
        CrawlerNotReady: { Type: 'Succeed' }
      }
    };

    // Create a log group for Step Functions
    const logGroup = new cdk.aws_logs.LogGroup(this, 'EmailTriageStateMachineLogGroup', {
      removalPolicy: dataRemovalPolicy
    });

    // State Machine
    const emailTriageStateMachine = new stepfunctions.StateMachine(this, 'EmailTriageStateMachine', {
      stateMachineType: stepfunctions.StateMachineType.EXPRESS,
      stateMachineName: stateMachineName,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(stateMachineDefinition)),
      role: stepFunctionsExecutionRole,
      logs: {
        destination: logGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true
      },
      tracingEnabled: true
    });

    // Dead Letter Queue for handling failed message processing
    const dlq = new sqs.Queue(this, 'ObjectCreationDLQ', {
      fifo: true,
      contentBasedDeduplication: true,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14) // Keep failed messages for 14 days for investigation
    });

    // SQS Queue with DLQ configuration
    const sqsObjectCreationQueue = new sqs.Queue(this, 'ObjectCreationQueue', {
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      enforceSSL: true,
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3 // After 3 failed processing attempts, send to DLQ
      },
      contentBasedDeduplication: true
    });

    // role for pipe
    const rolePipeTrigger = new iam.Role(this, 'RolePipeTrigger', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
      inlinePolicies: {
        'pipePolicy':
          new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
              resources: [sqsObjectCreationQueue.queueArn],
            }),
            new iam.PolicyStatement({
              actions: ['states:StartSyncExecution'],
              resources: [emailTriageStateMachine.stateMachineArn],
            }),
          ],
        }),
      }
    });

    // pipe to connect sqs queue to step function
    const pipeTriggerStepFunction = new pipes.CfnPipe(this, 'PipeTriggerStepFunction', {
      roleArn: rolePipeTrigger.roleArn,
      source: sqsObjectCreationQueue.queueArn,
      target: emailTriageStateMachine.stateMachineArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 1
        }
      }
    });

    // EventBridge Rule
    const rule = new events.Rule(this, 'EmailUploadRule', {
      ruleName: 'EmailS3UploadRule',
      description: 'Rule to create SQS message when object is created in S3 bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [emailBucketName],
          },
        },
      },
    });

    // Add role to the rule
    const eventBridgeRole = new iam.Role(this, 'EventBridgeRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });

    eventBridgeRole.addToPolicy(
      new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [sqsObjectCreationQueue.queueArn],
      })
    );

    //add a target
    rule.addTarget(new targets.SqsQueue(sqsObjectCreationQueue, {
      messageGroupId: 'fileupload',
      message: events.RuleTargetInput.fromEventPath('$')
    }));

    // Outputs
    new cdk.CfnOutput(this, 'EmailBucketNameOutput', {
      description: 'Name of the S3 bucket for uploading emails',
      value: emailBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'EmailOutputBucketNameOutput', {
      description: 'Name of the S3 bucket for the result',
      value: emailOutputBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'StateMachineArnOutput', {
      description: 'ARN of the Step Functions state machine',
      value: emailTriageStateMachine.stateMachineArn,
    });

    new cdk.CfnOutput(this, 'GlueDatabaseNameOutput', {
      description: 'Name of the Glue Database',
      value: glueDatabaseName,
    });

    new cdk.CfnOutput(this, 'DLQArnOutput', {
      description: 'ARN of the Dead Letter Queue',
      value: dlq.queueArn,
    });

    // Create QuickSight Data Source using Athena
    const quicksightDataSource = new quicksight.CfnDataSource(this, 'EmailTriageDataSource', {
      awsAccountId: this.account,
      dataSourceId: `email-triage-athena-source-${this.node.addr.substring(0, 8)}`,
      name: 'Email Triage Athena Source',
      type: 'ATHENA',
      dataSourceParameters: {
        athenaParameters: {
        }
      }
    });

    // Create QuickSight Data Set using Athena
    const quicksightDataSet = new quicksight.CfnDataSet(this, 'EmailTriageDataSet', {
      awsAccountId: this.account,
      dataSetId: `email-triage-dataset-${this.node.addr.substring(0, 8)}`,
      name: quicksightDataSetName,
      importMode: 'DIRECT_QUERY',
      physicalTableMap: {
        emailTriageTable: {
          customSql: {
            dataSourceArn: quicksightDataSource.attrArn,
            name: 'Email Triage Data',
            sqlQuery: `SELECT 
              target_department, 
              severity, 
              urgency, 
              topic, 
              summary, 
              timestamp,
              CAST(PARSE_DATETIME(timestamp, 'yyyy-MM-dd''T''HH:mm:ss.SSSZ') as TIMESTAMP) as formatted_timestamp
              FROM "${glueDatabaseName}"."${emailOutputBucketName.replace(/-/g, '_')}" 
              ORDER BY timestamp DESC`,
            columns: [
              {
                name: 'target_department',
                type: 'STRING'
              },
              {
                name: 'severity',
                type: 'STRING'
              },
              {
                name: 'urgency',
                type: 'STRING'
              },
              {
                name: 'topic',
                type: 'STRING'
              },
              {
                name: 'summary',
                type: 'STRING'
              },
              {
                name: 'timestamp',
                type: 'STRING'
              },
              {
                name: 'formatted_timestamp',
                type: 'DATETIME'
              }
            ]
          }
        }
      },
      logicalTableMap: {
        emailTriageLogicalTable: {
          alias: 'Email Triage Data',
          source: {
            physicalTableId: 'emailTriageTable'
          }
        }
      },
      permissions: [
        {
        principal: quicksightUserArn,
        actions: [
            'quicksight:UpdateDataSetPermissions',
            'quicksight:DescribeDataSet',
            'quicksight:DescribeDataSetPermissions',
            'quicksight:PassDataSet',
            'quicksight:DescribeIngestion',
            'quicksight:ListIngestions',
            'quicksight:UpdateDataSet',
            'quicksight:DeleteDataSet',
            'quicksight:CreateIngestion',
            'quicksight:CancelIngestion'
        ]
        }
      ]
    });

    // Add dependency to ensure resources are created in the correct order
    quicksightDataSet.addDependency(quicksightDataSource);

    // Output QuickSight Data Set ARN
    new cdk.CfnOutput(this, 'QuickSightDataSetOutput', {
      description: 'ARN of the QuickSight Data Set',
      value: quicksightDataSet.attrArn,
    });

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/AutomatedClassificationCdkStack/EmailTriageGlueCrawlerRole/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Glue crawler role requires access to put new log entries, get the Glue security configuration and read all objects in the output s3 bucket'
        }
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      'AutomatedClassificationCdkStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/Resource',
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'The BucketNotificationsHandler is a CDK construct that cannot be directly modified'
        }
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      'AutomatedClassificationCdkStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The BucketNotificationsHandler is a CDK construct that cannot be directly modified'
        }
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      'AutomatedClassificationCdkStack/StepFunctionsExecutionRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Step Functions execution role requires access to all objects in the S3 bucket to process emails'
        }
      ]
    )

    NagSuppressions.addResourceSuppressions(
      stepFunctionsExecutionRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Step Functions execution role requires access to all objects in the S3 bucket to process emails'
        }
      ]
    );
  }
}
