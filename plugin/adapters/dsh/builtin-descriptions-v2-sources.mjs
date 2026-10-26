// Official Core 0.2.1-rc.3 registration fingerprints; see tests/fixtures and capture-extra-builtins.
export const V2_DESCRIPTION_SOURCES = Object.freeze([
  {
    "name": "cordis_inspect_list",
    "sourceDigest": "sha256:5c17e4d164e1525d3205552c6f0a97ec57de5985f8ff72b530d5018a32776b26",
    "variant": {}
  },
  {
    "name": "cordis_inspect_query",
    "sourceDigest": "sha256:57ea7b97632ced5ff1b333321eb1d634105ca6ea2071a094ced5be5e09647b4d",
    "variant": {}
  },
  {
    "name": "schedule_create",
    "sourceDigest": "sha256:a3d7cda30051029df77aa97b85c506303df6e30d649381d5b91797acd41d352f",
    "variant": {}
  },
  {
    "name": "schedule_delete",
    "sourceDigest": "sha256:ad8db8e02e215a46c48163b2f7c44e2e62ffc7914510a192b2bc1224347558e0",
    "variant": {}
  },
  {
    "name": "schedule_update",
    "sourceDigest": "sha256:bbb061334a0e45707c214adeaf180c2e2cd3819643ea901bdee028232da4a667",
    "variant": {}
  },
  {
    "name": "str_replace_editor",
    "sourceDigest": "sha256:5ba972a137be8f7f47fe65ac8a92567f941ed8ca9daf981df48c73cc11dd9667",
    "variant": {}
  },
  {
    "name": "load_workspace_dependencies",
    "sourceDigest": "sha256:3ba0ce7016986206bd69a179815ef1d1c3594fb553d9cfc597be861bf0d2f360",
    "variant": {}
  },
  {
    "name": "present",
    "sourceDigest": "sha256:2e23315172585fb12ac673536b9a5707d41bb11353028c08f32662d5313e5914",
    "variant": {}
  },
  {
    "name": "send_message",
    "sourceDigest": "sha256:67f194b404146c38e68900831acb913ddbdb6709a85e3150ab5d731fd7bffd94",
    "variant": {}
  },
  {
    "name": "interrupt_agent",
    "sourceDigest": "sha256:4df2673a920841c9fac27af2a7841eaf78fac00e455bfcad6a11a3c39ab34c6c",
    "variant": {}
  },
  {
    "name": "todo_write",
    "sourceDigest": "sha256:163c8d93db2bbb63f51300c6f051b2e54dc2984dfbf22c7fe9d57ec5d33e26a6",
    "variant": {
      "allowParallelInProgress": true
    }
  },
  {
    "name": "todo_write",
    "sourceDigest": "sha256:c925990edf4d99618e95c9472ef804cb367bda6067de9733ea51f5b33ba82ed4",
    "variant": {
      "allowParallelInProgress": false
    }
  },
  {
    "name": "ralph",
    "sourceDigest": "sha256:39cc5d70b4be9a9aa329fab397a9ff60c186b5989182f3eb8ac1eb6d36041064",
    "variant": {}
  },
  {
    "name": "ask_user_question",
    "sourceDigest": "sha256:ef08f4e8055eafb63a19a8e0fa73fccc080112ff45daf6fe5fa77f170c09ac30",
    "variant": {
      "mode": "timed",
      "timeout": 120
    }
  },
  {
    "name": "skill",
    "sourceDigest": "sha256:87d32f7f90baa0308a615fc99d1448aad5ae5da6128cb9e380884ed773cefafd",
    "variant": {}
  },
  {
    "name": "glob",
    "sourceDigest": "sha256:a63d3f55eff811fdeb376cf024e26dc0899ede42bf70b1781c98bf4825581ebf",
    "variant": {
      "sampleOverCapGlobResults": false
    }
  },
  {
    "name": "grep",
    "sourceDigest": "sha256:0207a37259c7602217ae6a6f70a321e2b12723c9b95f8afdd424f5e63591d649",
    "variant": {
      "sampleOverCapGlobResults": false
    }
  },
  {
    "name": "glob",
    "sourceDigest": "sha256:88ccf3a63b8bfcd0b9d41ada24d2e8e1832190fccf56d33eea4f63c70e249fb8",
    "variant": {
      "sampleOverCapGlobResults": true
    }
  },
  {
    "name": "terminal_open",
    "sourceDigest": "sha256:c2b4661ee48e07ee6ced1d7645c9a392f23fbcf4b6274e1e497c3459a978446a",
    "variant": {
      "enableRunInBackground": false
    }
  },
  {
    "name": "terminal_send",
    "sourceDigest": "sha256:e543fc32356b34c406e9c33ac61c9512e21e9fcd50371b57181b45eb6d883a19",
    "variant": {
      "enableRunInBackground": false
    }
  },
  {
    "name": "terminal_send",
    "sourceDigest": "sha256:34a769ed88392920f9f009721b5d3e3ed0ee9a7edd44f1fec30349a67b8faa12",
    "variant": {
      "enableRunInBackground": true
    }
  },
  {
    "name": "working_directory",
    "sourceDigest": "sha256:94e5b848621fc3b00f96df75d5ff8cb75fe10aaad8aad35ec2612be4569eac4a",
    "variant": {}
  },
  {
    "name": "bash",
    "sourceDigest": "sha256:586ca91694819d1b8228d1e1dfa978d0c355f3f574c2105509bc0589c09fb243",
    "variant": {}
  },
  {
    "name": "pwsh",
    "sourceDigest": "sha256:684d09b30c02224e0d1c39202fa8d1b62ad1462faf3e9f88683656e34305e261",
    "variant": {}
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:db1d3ee2af75461c670a1b22cb3c81486d9eac7ff9af26c3cbf39eebfbd88510",
    "variant": {
      "inherits": false,
      "continuable": false,
      "selectable": false,
      "defaults": false
    }
  },
  {
    "name": "list_subagent_models",
    "sourceDigest": "sha256:72c4eb063e40f9ae4e1f4f06c44c1cb086574fe2c34560c04c138b81e7323fbd",
    "variant": {
      "inherits": false,
      "continuable": false,
      "selectable": true,
      "defaults": false
    }
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:1715ed770cad40122d68e592749bf1db1328d4cb1f1fc1eb47661fec80860f6e",
    "variant": {
      "inherits": false,
      "continuable": false,
      "selectable": true,
      "defaults": false
    }
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:27de9f0474a4cf85df41a5c07fe23a38e21696e61e29b51b3730c1cf3b7be940",
    "variant": {
      "inherits": false,
      "continuable": false,
      "selectable": true,
      "defaults": true
    }
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:a6a76b87abf319cb2f43adf0da96e0b570680e4cc269d4bc72ef4ca34fdd413f",
    "variant": {
      "inherits": false,
      "continuable": true,
      "selectable": false,
      "defaults": false
    }
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:23b328c3bc0ad993428dee97d042df3d15e92ec65ebf1fd7df07506fb06dff98",
    "variant": {
      "inherits": false,
      "continuable": true,
      "selectable": true,
      "defaults": false
    }
  },
  {
    "name": "subagent",
    "sourceDigest": "sha256:2aa3d883e0e309fa8964d0181970ca03615cfb817511c6c4dc42e239ed5e538d",
    "variant": {
      "inherits": false,
      "continuable": true,
      "selectable": true,
      "defaults": true
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:ce01909a090489e5486e23949ffa1a83c8c2fea82c9e9465ce1cbb37947786da",
    "variant": {
      "inherits": true,
      "continuable": false,
      "selectable": false,
      "defaults": false
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:d8420b22cf3924b8c0d0852c734f700776b148e397a33652f0c890cc1aae0111",
    "variant": {
      "inherits": true,
      "continuable": false,
      "selectable": true,
      "defaults": false
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:d6dbba6e054ba61c92bb11cc1186b7cfbabf1fb2e307d65c8ae72dcae804d967",
    "variant": {
      "inherits": true,
      "continuable": false,
      "selectable": true,
      "defaults": true
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:8a18fed1e8b6da9c8bc53e04e5fda59c0e915e697770709b643eff69224668c1",
    "variant": {
      "inherits": true,
      "continuable": true,
      "selectable": false,
      "defaults": false
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:f8720ce52c2a4d94779da42805559487d3aeeb9dc841b01cb27e19b98e67c33a",
    "variant": {
      "inherits": true,
      "continuable": true,
      "selectable": true,
      "defaults": false
    }
  },
  {
    "name": "subagent_fork",
    "sourceDigest": "sha256:14085b00e240f970d9bf36f8553d7c0758e28905810c959eae222b293e2efb13",
    "variant": {
      "inherits": true,
      "continuable": true,
      "selectable": true,
      "defaults": true
    }
  },
  {
    "name": "exit_plan_mode",
    "sourceDigest": "sha256:8ec2df611915a6ecd70e2aa1e45846e06d6dbe98163d992d9f58a842ca0a413c",
    "variant": {}
  }
].map(row => Object.freeze({ ...row, variant: Object.freeze(row.variant) })));
