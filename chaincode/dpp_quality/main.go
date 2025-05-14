package main

import (
    "log"

    "github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// DPPQualityContract steht in dpp_quality_gs1.go – beide in package main
func main() {
    cc, err := contractapi.NewChaincode(&DPPQualityContract{})
    if err != nil {
        log.Panicf("Error creating DPPQualityContract chaincode: %v", err)
    }
    if err := cc.Start(); err != nil {
        log.Panicf("Error starting DPPQualityContract chaincode: %v", err)
    }
}
