pipeline {
    agent any

    stages {

        stage('SonarQube Analysis') {
            steps {
                withSonarQubeEnv('SonarQube') {
                    script {
                        def scannerHome = tool(
                            name: 'SonarQubeScanner',
                            type: 'hudson.plugins.sonar.SonarRunnerInstallation'
                        )

                        echo "SonarScanner: ${scannerHome}"

                        sh """
                            ${scannerHome}/bin/sonar-scanner \
                            -Dsonar.projectKey=myflix-auth-service \
                            -Dsonar.projectName=myflix-auth-service \
                            -Dsonar.sources=.
                        """
                    }
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 5, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

    }
}