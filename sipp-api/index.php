<?php

set_time_limit(45);
// Enable CORS for API usage
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
} else {
    $data = $_GET;
}

// Validate input
if (!isset($data['destination']) || !isset($data['action'])) {
    echo json_encode([
        "success" => false,
        "error" => "Missing required parameters: 'destination' and 'action'."
    ]);
    exit;
}
$action = $data['action'];
$destination = $data['destination'];

$async = isset($data['async']) && $data['async']==yes  ? "-bg" : "";

$current_dir = getcwd();
$full_path="x";
if (!isset($data['domain']) || !isset($data['device']) || !isset($data['password'])) {
    echo json_encode([
        "success" => false,
        "error" => "Missing required parameters: 'domain' and 'device' and 'password'."
    ]);
    exit;
}
else
{
    
    $name = isset($data['name'])? $data['name'] : 'test user';
    $domain = $data['domain'];
    $device = $data['device'];
    $password = $data['password'];

    $tmp_file_name = "tmp/$action-$device-$domain.csv";
    $full_path = $current_dir . "/" . $tmp_file_name;
    $sipp_csv = fopen($full_path, "w");
    fwrite($sipp_csv, "SEQUENTIAL\n");
    fwrite($sipp_csv, "$name;$device;$domain;[authentication username=$device password=$password]\n");
    fclose($sipp_csv);
    

}

// supported actions for the API
// register_once - register a device one time, return the results
// register_long_accept_invite - register a device and repeat for 1 hour run in background
// call - register and then make a call to a destination, return the results. 


// Required parameters
$destination = escapeshellarg($data['destination']); // SIP destination (e.g., IP:port)
$action = $data['action'];      // SIPp scenario XML file

// Optional parameters (add more as needed based on SIPp documentation)
$options = [];



// Add dynamic options from the request
foreach ($data as $key => $value) {
    if (!in_array($key, ['destination', 'scenario', 'uac', 'uas', 'trace_logs'])) {
        $options[] = escapeshellarg("--$key=$value");
    }
}

//require domain,user, password

// Construct the SIPp command

$scenerio = "register_once.sipp.xml";
$custom = "";
$m=1;

if ($action == "call") {
    
    $scenerio = isset($data['scenerio'])? $data['scenerio'] : "register_then_call.sipp.xml";
    $number = isset($data['number']) ? $data['number'] : 18585551212;
    $timeout = isset($data['timeout']) ? $data['timeout'] : 30000;
    $custom = " -s $number -d $timeout ";

}
else if ($action == "accept_invite") {
    $scenerio = "register_then_accept.sipp.xml";
    $custom = " -oocsf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a_short.xml -aa -default_behaviors -abortunexp ";
    $custom .= " ";

    //<action><exec rtp_stream="file.wav" /></action>

}  

$scenerio = $current_dir . "/../sipp/scripts/" . $scenerio;

$rua = "/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/random_user_agents.csv";

$random = random_int(100, 999);
$sipp_command = "sudo /usr/bin/sipp $destination $custom -sf $scenerio  -m $m  -inf $full_path -inf $rua -key expires 60 -mp 9$random  -nostdin $async ";

// Execute the command
//exec($sipp_command , $output, $return_var);
$output = shell_exec($sipp_command. " 2>&1");


// Return the response
if ($return_var === 0) {
    echo json_encode([
        "success" => true,
        "output" => $output
    ]);
} else {
    #header('Content-Type: application/json; charset=utf-8');
    // echo json_encode([
    //     "success" => false,
    //     "error" => "SIPp command failed.",
    //     "sipp_command" => $sipp_command,
    //     "details" => $output
    // ]);
    if (isset($data['message']))
    {
        echo "<h2>";
        echo $data['message'];
        echo "</h2>";
    }
    echo "<span >";
    echo  $sipp_command;
    echo "</span>";
    echo "<pre>";
    echo  $output;
    echo "</pre>";
}
    
?>