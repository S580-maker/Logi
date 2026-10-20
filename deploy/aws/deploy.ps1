param(
  [ValidatePattern('^[a-z]{2}(-gov)?-[a-z]+-\d$')]
  [string]$Region = 'us-east-1',
  [ValidateSet('t4g.small', 't4g.medium')]
  [string]$InstanceType = 't4g.small',
  [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,127}$')]
  [string]$StackName = 'logi-hosting'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$templatePath = Join-Path $PSScriptRoot 'template.yaml'
$environmentPath = Join-Path $repositoryRoot '.env'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'AWS CLI is required. Install AWS CLI v2, sign in, then run this script again.'
}
if (-not (Test-Path $environmentPath)) {
  throw 'The root .env file is missing. Configure production environment values before deploying.'
}

$environmentText = Get-Content -LiteralPath $environmentPath -Raw
$requiredNames = @(
  'DATABASE_URL',
  'DATABASE_CA_CERT_BASE64',
  'SESSION_SECRET',
  'PEPPER',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD'
)
foreach ($name in $requiredNames) {
  if ($environmentText -notmatch "(?m)^\s*$([regex]::Escape($name))\s*=\s*\S") {
    throw "The .env file is missing $name. No environment values were displayed."
  }
}

& aws sts get-caller-identity --region $Region --no-cli-pager *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'AWS CLI is not authenticated. Sign in with AWS CLI, then run this script again.'
}

$subnetId = & aws ec2 describe-subnets `
  --region $Region `
  --filters Name=default-for-az,Values=true `
  --query 'Subnets[0].SubnetId' `
  --output text `
  --no-cli-pager
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($subnetId) -or $subnetId -eq 'None') {
  throw "No default VPC subnet was found in $Region. Create a public subnet or choose a region with a default VPC."
}
$vpcId = & aws ec2 describe-subnets `
  --region $Region `
  --subnet-ids $subnetId `
  --query 'Subnets[0].VpcId' `
  --output text `
  --no-cli-pager
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vpcId) -or $vpcId -eq 'None') {
  throw "Could not determine the VPC for the default subnet in $Region."
}

$randomBytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$originToken = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$temporaryDirectory = Join-Path $env:TEMP "logi-aws-deploy-$([guid]::NewGuid().ToString('N'))"
$archivePath = Join-Path $temporaryDirectory 'app.zip'
$commandInputPath = Join-Path $temporaryDirectory 'ssm-command.json'
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  $archiveItems = @(
    'api', 'db', 'middleware', 'public', 'routes', 'scripts', 'utils',
    'server.js', 'package.json', 'package-lock.json', 'Dockerfile',
    '.dockerignore', 'deploy'
  ) | ForEach-Object { Join-Path $repositoryRoot $_ }
  Compress-Archive -Path $archiveItems -DestinationPath $archivePath -CompressionLevel Optimal

  & aws cloudformation deploy `
    --region $Region `
    --stack-name $StackName `
    --template-file $templatePath `
    --parameter-overrides "SubnetId=$subnetId" "VpcId=$vpcId" "InstanceType=$InstanceType" "OriginVerifyToken=$originToken" `
    --capabilities CAPABILITY_IAM `
    --tags Project=Logi `
    --no-cli-pager
  if ($LASTEXITCODE -ne 0) {
    throw 'CloudFormation deployment failed. Check the stack Events in AWS CloudFormation for details.'
  }

  $outputs = & aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $StackName `
    --query 'Stacks[0].Outputs' `
    --output json `
    --no-cli-pager | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the deployment outputs from CloudFormation.' }

  $instanceId = ($outputs | Where-Object OutputKey -eq 'InstanceId').OutputValue
  $bucketName = ($outputs | Where-Object OutputKey -eq 'ArtifactBucketName').OutputValue
  $websiteUrl = ($outputs | Where-Object OutputKey -eq 'WebsiteUrl').OutputValue
  if (-not $instanceId -or -not $bucketName -or -not $websiteUrl) {
    throw 'The completed CloudFormation stack did not return all required deployment outputs.'
  }

  & aws s3 cp $archivePath "s3://$bucketName/releases/app.zip" --region $Region --sse AES256 --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload the application bundle to the private deployment bucket.' }

  & aws s3 cp $environmentPath "s3://$bucketName/private/app.env" --region $Region --sse AES256 --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload the encrypted environment file to the private deployment bucket.' }

  $deadline = (Get-Date).AddMinutes(15)
  $ssmReady = $false
  while ((Get-Date) -lt $deadline) {
    $pingStatus = & aws ssm describe-instance-information `
      --region $Region `
      --filters "Key=InstanceIds,Values=$instanceId" `
      --query 'InstanceInformationList[0].PingStatus' `
      --output text `
      --no-cli-pager 2>$null
    if ($LASTEXITCODE -eq 0 -and $pingStatus -eq 'Online') {
      $ssmReady = $true
      break
    }
    Start-Sleep -Seconds 15
  }
  if (-not $ssmReady) {
    throw "The EC2 host did not become available through AWS Systems Manager. Instance ID: $instanceId"
  }

  $commands = @(
    'set -eu',
    "aws s3 cp s3://$bucketName/releases/app.zip /opt/logi/app.zip --region $Region",
    'mkdir -p /opt/logi/app',
    'unzip -q -o /opt/logi/app.zip -d /opt/logi/app',
    "aws s3 cp s3://$bucketName/private/app.env /opt/logi/app.env --region $Region",
    'chmod 600 /opt/logi/app.env',
    'docker network create logi-internal 2>/dev/null || true',
    'docker volume create logi-storage >/dev/null',
    'docker volume create logi-redis-data >/dev/null',
    'docker build -t logi-app:latest /opt/logi/app',
    'docker rm -f logi-app logi-proxy logi-redis >/dev/null 2>&1 || true',
    'docker run -d --name logi-redis --restart unless-stopped --network logi-internal -v logi-redis-data:/data redis:7-alpine redis-server --appendonly yes',
    'docker run -d --name logi-app --restart unless-stopped --network logi-internal --env-file /opt/logi/app.env -e NODE_ENV=production -e PORT=3000 -e REDIS_URL=redis://logi-redis:6379 -e TRUST_PROXY=true -v logi-storage:/app/storage logi-app:latest',
    "docker run -d --name logi-proxy --restart unless-stopped --network logi-internal -p 80:80 -e ORIGIN_VERIFY_TOKEN=$originToken -e FORWARDED_PROTO=https -v /opt/logi/app/deploy/aws/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro nginx:1.28-alpine",
    'for attempt in $(seq 1 30); do if docker exec logi-app node -e "fetch(\"http://127.0.0.1:3000/\").then(r=>process.exit(r.status < 500 ? 0 : 1)).catch(()=>process.exit(1))"; then exit 0; fi; sleep 5; done',
    'docker logs --tail 80 logi-app',
    'exit 1'
  )
  $requestJson = @{
    DocumentName = 'AWS-RunShellScript'
    InstanceIds = @($instanceId)
    Parameters = @{ commands = $commands }
    TimeoutSeconds = 3600
    Comment = 'Deploy Logi application containers'
  } | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $commandInputPath -Value $requestJson -Encoding ascii

  $commandId = & aws ssm send-command `
    --region $Region `
    --cli-input-json "file://$commandInputPath" `
    --query 'Command.CommandId' `
    --output text `
    --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the deployment command on the EC2 host.' }

  $deadline = (Get-Date).AddMinutes(20)
  do {
    Start-Sleep -Seconds 10
    $invocationJson = & aws ssm get-command-invocation `
      --region $Region `
      --command-id $commandId `
      --instance-id $instanceId `
      --output json `
      --no-cli-pager 2>$null
    if ($LASTEXITCODE -eq 0) { $invocation = $invocationJson | ConvertFrom-Json }
  } while ((-not $invocation -or $invocation.Status -in @('Pending', 'InProgress', 'Delayed')) -and (Get-Date) -lt $deadline)

  if (-not $invocation -or $invocation.Status -ne 'Success') {
    if ($invocation.StandardErrorContent) { Write-Error $invocation.StandardErrorContent }
    if ($invocation.StandardOutputContent) { Write-Output $invocation.StandardOutputContent }
    throw "The EC2 deployment did not complete successfully. Status: $($invocation.Status)"
  }

  Write-Output "Logi is deployed at $websiteUrl"
  Write-Output 'The app uses your existing PostgreSQL database. Uploaded slides are stored on the encrypted EC2 volume.'
} finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
